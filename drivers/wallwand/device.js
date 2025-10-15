'use strict';
const { ZwaveDevice } = require('homey-zwavedriver');

module.exports = class WallWandDevice extends ZwaveDevice {
  static DEVICE_TYPES = {
    DIMMER: 'dimmer',
    SWITCH: 'switch',
  };

  async onInit() {
    super.onInit();
    this.log(`[Device onInit] ${this.getName()} created`);
  }

  async onNodeInit({ node } = {}) {
    node = node || this.node;
    if (!node) {
      return this.error('[onNodeInit] node missing');
    }

    //this.enableDebug();
    this.printNode();

    this._endpointTypes = {};

    try {
      // Register listeners for endpoint-less reports (physical presses)
      this._registerRootDeviceListeners(node);

      await this._discoverAllEndpoints(node);
      await this._syncAllEndpointStates(node);
      await this._cleanupOrphanedEndpoints(); // Clean up unused capabilities

      this._registerFlowTriggers();

      await this._applyLabelsFromSettings(this.getSettings());

      this.log('onNodeInit finished successfully.');
    } catch (error) {
      this.error('[onNodeInit] Initialization failed:', error);
      throw error;
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys = [] }) {
    const hasLabelChanges = changedKeys.some(k => k.startsWith('label_ep'));

    if (hasLabelChanges) {
      try {
        await this._applyLabelsFromSettings(newSettings);
      } catch (error) {
        this.error('[onSettings] Failed to apply label changes:', error);
        throw error;
      }
    }

    return super.onSettings({ oldSettings, newSettings, changedKeys });
  }

  _registerFlowTriggers() {
    this.log('Registering flow triggers...');
    this.endpointOnTrigger = this.homey.flow.getTriggerCard('endpoint_on');
    this.endpointOffTrigger = this.homey.flow.getTriggerCard('endpoint_off');
    this.endpointDimTrigger = this.homey.flow.getTriggerCard('endpoint_dim');

    const autocompleteListener = async (query) => {
      return this._getEndpointAutocompleteList(query);
    };

    const dimAutocompleteListener = async (query) => {
      const allEndpoints = await this._getEndpointAutocompleteList(query);
      return allEndpoints.filter(item => {
        const endpointNum = item.id;
        return this._endpointTypes[endpointNum] === WallWandDevice.DEVICE_TYPES.DIMMER;
      });
    };

    if (this.endpointOnTrigger) {
      this.endpointOnTrigger.registerArgumentAutocompleteListener('endpoint', autocompleteListener);
    }
    if (this.endpointOffTrigger) {
      this.endpointOffTrigger.registerArgumentAutocompleteListener('endpoint', autocompleteListener);
    }
    if (this.endpointDimTrigger) {
      this.endpointDimTrigger.registerArgumentAutocompleteListener('endpoint', dimAutocompleteListener);
    }
  }

  async _getEndpointAutocompleteList(query) {
    const settings = this.getSettings();
    const items = [];
    for (const id in this._endpointTypes) {
      if (this._endpointTypes[id]) { // if supported
        const endpointNum = parseInt(id, 10);
        const customLabel = (settings[`label_ep${endpointNum}`] || '').trim();
        const isDimmer = this._endpointTypes[id] === WallWandDevice.DEVICE_TYPES.DIMMER;

        const capId = isDimmer ? `dim.ep${endpointNum}` : `onoff.ep${endpointNum}`;
        const defaultLabel = this._getDefaultLabel(endpointNum, isDimmer, capId);
        const name = customLabel || defaultLabel;

        items.push({
          name: name,
          id: endpointNum,
        });
      }
    }
    return items.filter(item => item.name.toLowerCase().includes(query.toLowerCase()));
  }

  /**
   * Registers listeners on the root device to catch reports that are missing
   * an endpoint ID (typically from physical button presses on the panel).
   * These listeners trigger a sync for all relevant endpoints.
   */
  _registerRootDeviceListeners(node) {
    if (node && node.CommandClass && node.CommandClass.COMMAND_CLASS_SWITCH_MULTILEVEL) {
      node.CommandClass.COMMAND_CLASS_SWITCH_MULTILEVEL.on('report', async () => {
        this.log('[Root Report] Multilevel report detected. Syncing all dimmer endpoints...');
        await this._syncEndpointsByType(WallWandDevice.DEVICE_TYPES.DIMMER);
      });
    }

    if (node && node.CommandClass && node.CommandClass.COMMAND_CLASS_SWITCH_BINARY) {
      node.CommandClass.COMMAND_CLASS_SWITCH_BINARY.on('report', async () => {
        this.log('[Root Report] Binary report detected. Syncing all switch endpoints...');
        await this._syncEndpointsByType(WallWandDevice.DEVICE_TYPES.SWITCH);
      });
    }

    this.log('Root device listeners registered for physical press reports.');
  }

  async _discoverAllEndpoints(node) {
    const endpoints = node.MultiChannelNodes || {};
    const endpointIds = Object.keys(endpoints);

    if (endpointIds.length === 0) {
      this.log('No endpoints found; cleaning up all capabilities.');
      await this._cleanupAllEndpoints();
      return;
    }

    this.log(`Discovering ${endpointIds.length} endpoint(s)...`);

    for (const id of endpointIds) {
      const endpointNum = parseInt(id, 10);

      if (isNaN(endpointNum) || endpointNum < 1) {
        this.error(`Invalid endpoint ID: ${id}`);
        continue;
      }

      await this._discoverOneEndpoint(endpointNum, endpoints[id]);
    }
  }

  async _discoverOneEndpoint(endpointNum, endpoint) {
    if (!endpoint || this._endpointTypes[endpointNum]) {
      return;
    }

    const commandClass = endpoint.CommandClass || {};
    const deviceType = this._detectEndpointType(endpoint, commandClass);

    if (!deviceType) {
      this.log(`Endpoint ${endpointNum}: Type "${endpoint.deviceClassGeneric}" is not supported, removing capabilities.`);
      this._endpointTypes[endpointNum] = null; // Mark as unsupported
      await this._removeEndpointCapabilities(endpointNum);
      return;
    }

    this.log(`Endpoint ${endpointNum}: Discovered as ${deviceType}`);

    try {
      await this._registerEndpointCapabilities(endpointNum, deviceType);
      this._endpointTypes[endpointNum] = deviceType;
    } catch (error) {
      this.error(`Failed to register endpoint ${endpointNum}:`, error);
    }
  }

  _detectEndpointType(endpoint, commandClass) {
    const isDimmer =
      endpoint.deviceClassGeneric === 'GENERIC_TYPE_SWITCH_MULTILEVEL' &&
      commandClass.COMMAND_CLASS_SWITCH_MULTILEVEL;

    const isSwitch =
      endpoint.deviceClassGeneric === 'GENERIC_TYPE_SWITCH_BINARY' &&
      commandClass.COMMAND_CLASS_SWITCH_BINARY;

    if (isDimmer) return WallWandDevice.DEVICE_TYPES.DIMMER;
    if (isSwitch) return WallWandDevice.DEVICE_TYPES.SWITCH;
    return null;
  }

  async _registerEndpointCapabilities(endpointNum, deviceType) {
    const onoffCap = `onoff.ep${endpointNum}`;
    const dimCap = `dim.ep${endpointNum}`;

    if (deviceType === WallWandDevice.DEVICE_TYPES.DIMMER) {
      this.registerCapability(onoffCap, 'SWITCH_MULTILEVEL', { multiChannelNodeId: endpointNum });
      this.registerCapability(dimCap, 'SWITCH_MULTILEVEL', { multiChannelNodeId: endpointNum });
    } else if (deviceType === WallWandDevice.DEVICE_TYPES.SWITCH) {
      this.registerCapability(onoffCap, 'SWITCH_BINARY', { multiChannelNodeId: endpointNum });
    }
  }

  _isValidReport(report, requiredField) {
    return report && typeof report === 'object' && requiredField in report;
  }

  async _syncAllEndpointStates(node) {
    const endpoints = node.MultiChannelNodes || {};
    const discoveredIds = Object.keys(this._endpointTypes);

    this.log(`Syncing state for ${discoveredIds.length} endpoint(s)...`);

    for (const id of discoveredIds) {
      const endpointNum = parseInt(id, 10);
      await this._syncOneEndpointState(endpointNum, endpoints[id]);
    }
  }

  async _syncEndpointsByType(deviceType) {
    const node = this.node;
    if (!node) {
      this.error('[_syncEndpointsByType] Node not available');
      return;
    }

    const endpoints = node.MultiChannelNodes || {};
    const endpointsToSync = Object.keys(this._endpointTypes)
      .filter(id => this._endpointTypes[id] === deviceType)
      .map(id => parseInt(id, 10));

    if (endpointsToSync.length === 0) {
      this.log(`[Sync] No ${deviceType} endpoints found to sync`);
      return;
    }

    this.log(`[Sync] Syncing ${endpointsToSync.length} ${deviceType} endpoint(s): [${endpointsToSync.join(', ')}]`);

    for (const endpointNum of endpointsToSync) {
      await this._syncOneEndpointState(endpointNum, endpoints[endpointNum]);
    }
  }

  async _syncOneEndpointState(endpointNum, endpoint) {
    const deviceType = this._endpointTypes[endpointNum];

    if (!endpoint) {
      this.log(`Endpoint ${endpointNum}: No longer available, removing capabilities.`);
      await this._removeEndpointCapabilities(endpointNum);
      return;
    }

    if (deviceType === null || deviceType === undefined) {
      return; // Skip unsupported or non-existent endpoints
    }

    const commandClass = endpoint.CommandClass || {};
    const onoffCap = `onoff.ep${endpointNum}`;
    const dimCap = `dim.ep${endpointNum}`;

    try {
      let syncSuccess = false;
      if (deviceType === WallWandDevice.DEVICE_TYPES.DIMMER) {
        syncSuccess = await this._syncDimmerState(endpointNum, commandClass, onoffCap, dimCap);
      } else if (deviceType === WallWandDevice.DEVICE_TYPES.SWITCH) {
        syncSuccess = await this._syncSwitchState(endpointNum, commandClass, onoffCap, dimCap);
      }

      if (!syncSuccess) {
        throw new Error('Invalid or missing report during sync');
      }
    } catch (error) {
      this.error(`Failed to sync state for endpoint ${endpointNum}:`, error.message);
      this.log(`Marking endpoint ${endpointNum} as unsupported and removing capabilities.`);
      this._endpointTypes[endpointNum] = null; // Mark as unsupported
      await this._removeEndpointCapabilities(endpointNum);
    }
  }

  async _syncDimmerState(endpointNum, commandClass, onoffCap, dimCap) {
    await this._ensureCapability(onoffCap);
    await this._ensureCapability(dimCap);

    const cc = commandClass.COMMAND_CLASS_SWITCH_MULTILEVEL;
    if (!cc || typeof cc.SWITCH_MULTILEVEL_GET !== 'function') {
      this.error(`[Sync][EP ${endpointNum}] SWITCH_MULTILEVEL command class not available.`);
      return false;
    }

    const report = await cc.SWITCH_MULTILEVEL_GET();

    if (this._isValidReport(report, 'Current Value')) {
      const dimValue = report['Current Value'];
      this.log(`[Sync][EP ${endpointNum}] Dimmer current value: ${dimValue}`);
      this._setOnOff(onoffCap, dimValue > 0);
      this._setDim(dimCap, dimValue / 99);
      return true;
    }

    return false;
  }

  async _syncSwitchState(endpointNum, commandClass, onoffCap, dimCap) {
    await this._removeIfPresent(dimCap);
    await this._ensureCapability(onoffCap);

    const cc = commandClass.COMMAND_CLASS_SWITCH_BINARY;
    if (!cc || typeof cc.SWITCH_BINARY_GET !== 'function') {
      this.error(`[Sync][EP ${endpointNum}] SWITCH_BINARY command class not available.`);
      return false;
    }

    const report = await cc.SWITCH_BINARY_GET();
    if (this._isValidReport(report, 'Value')) {
      const isOn = report.Value === 'on/enable' || report.Value === 1;
      this.log(`[Sync][EP ${endpointNum}] Switch current value: ${isOn}`);
      this._setOnOff(onoffCap, isOn);
      return true;
    }

    return false;
  }

  async _cleanupOrphanedEndpoints() {
    this.log('Cleaning up orphaned endpoint capabilities...');
    const manifestCapabilities = this.driver.manifest.capabilities || [];

    // Find the highest possible endpoint number from the manifest to create a check range.
    let maxManifestEndpoint = 0;
    for (const capId of manifestCapabilities) {
      const match = capId.match(/\.ep(\d+)$/);
      if (match && match[1]) {
        const endpointNum = parseInt(match[1], 10);
        if (endpointNum > maxManifestEndpoint) {
          maxManifestEndpoint = endpointNum;
        }
      }
    }

    if (maxManifestEndpoint === 0) {
      this.log('No endpoint capabilities found in manifest to clean up.');
      return;
    }

    // Check every possible endpoint up to the max found in the manifest.
    for (let i = 1; i <= maxManifestEndpoint; i++) {
      // If an endpoint was not discovered, or was discovered but marked as unsupported (null).
      if (!this._endpointTypes.hasOwnProperty(i) || this._endpointTypes[i] === null) {
        if (this.hasCapability(`onoff.ep${i}`) || this.hasCapability(`dim.ep${i}`)) {
          this.log(`Endpoint ${i} is orphaned or unsupported. Removing its capabilities.`);
          await this._removeEndpointCapabilities(i);
        }
      }
    }
  }

  async _applyLabelsFromSettings(settings = {}) {
    const supportedEndpoints = Object.keys(this._endpointTypes)
      .filter(id => this._endpointTypes[id]);

    for (const id of supportedEndpoints) {
      const endpointNum = parseInt(id, 10);
      await this._applyLabelToEndpoint(endpointNum, settings);
    }
  }

  async _applyLabelToEndpoint(endpointNum, settings) {
    const customLabel = (settings[`label_ep${endpointNum}`] || '').trim();
    const onoffCap = `onoff.ep${endpointNum}`;
    const dimCap = `dim.ep${endpointNum}`;
    const isDimmer = this.hasCapability(dimCap);
    const capId = isDimmer ? dimCap : onoffCap;

    const defaultLabel = this._getDefaultLabel(endpointNum, isDimmer, capId);
    const finalLabel = customLabel || defaultLabel;

    try {
      if (this.hasCapability(onoffCap)) {
        await this._setTitle(onoffCap, finalLabel);
      }
      if (isDimmer && this.hasCapability(dimCap)) {
        await this._setTitle(dimCap, finalLabel);
      }
    } catch (error) {
      this.error(`Failed to set label for endpoint ${endpointNum}:`, error);
    }
  }

  _getDefaultLabel(endpointNum, isDimmer, capabilityId) {
    const manifestDefault =
      this.driver?.manifest?.capabilitiesOptions?.[capabilityId]?.title?.en;

    if (manifestDefault) {
      return manifestDefault;
    }

    const typeLabel = isDimmer ? 'Dimmer' : 'Switch';
    return `${typeLabel} ${endpointNum}`;
  }

  async _cleanupAllEndpoints() {
    this._endpointTypes = {};
    const manifestCapabilities = this.driver.manifest.capabilities || [];
    const endpointCapabilities = manifestCapabilities.filter(id => id.match(/\.ep\d+$/));
    const cleanupPromises = endpointCapabilities.map(capId =>
      this._removeIfPresent(capId)
    );
    await Promise.all(cleanupPromises);
    await this.setSettings(this._blankLabels());
  }

  async _removeEndpointCapabilities(endpointNum) {
    await this._removeIfPresent(`dim.ep${endpointNum}`);
    await this._removeIfPresent(`onoff.ep${endpointNum}`);
  }

  _blankLabels() {
    const labels = {};
    const manifestSettings = this.driver.manifest.settings || [];
    for (const setting of manifestSettings) {
      if (setting.id.startsWith('label_ep')) {
        labels[setting.id] = '';
      }
    }
    return labels;
  }

  async _ensureCapability(cap) {
    if (!this.hasCapability(cap)) {
      await this.addCapability(cap).catch(err => {
        this.error(`Failed to add capability ${cap}:`, err);
      });
    }
  }

  async _removeIfPresent(cap) {
    if (this.hasCapability(cap)) {
      await this.removeCapability(cap).catch(err => {
        this.error(`Failed to remove capability ${cap}:`, err);
      });
    }
  }

  async _setTitle(cap, title) {
    return this.setCapabilityOptions(cap, { title }).catch(err => {
      this.error(`Failed to set title for ${cap}:`, err);
    });
  }

  _setOnOff(cap, value) {
    if (this.hasCapability(cap)) {
      const oldValue = this.getCapabilityValue(cap);
      const newValue = !!value;

      this.setCapabilityValue(cap, newValue).catch(err => {
        this.error(`Failed to set ${cap} to ${newValue}:`, err);
      });

      if (oldValue === newValue) return;

      const match = cap.match(/^onoff\.ep(\d+)$/);
      if (match) {
        const endpointNum = parseInt(match[1], 10);

        const settings = this.getSettings();
        const customLabel = (settings[`label_ep${endpointNum}`] || '').trim();
        const isDimmer = this._endpointTypes[endpointNum] === WallWandDevice.DEVICE_TYPES.DIMMER;
        const defaultLabel = this._getDefaultLabel(endpointNum, isDimmer, cap);
        const endpointLabel = customLabel || defaultLabel;

        this.log(`Flow trigger for endpoint ${endpointNum} (${endpointLabel}) turned ${newValue ? 'ON' : 'OFF'}`);

        const tokens = { endpoint_label: endpointLabel };
        const state = { endpoint: endpointNum };

        const trigger = newValue ? this.endpointOnTrigger : this.endpointOffTrigger;
        if (trigger) {
          trigger.trigger(this, tokens, state)
            .catch(this.error);
        }
      }
    }
  }

  _setDim(cap, value01) {
    const normalizedValue = Math.max(0, Math.min(1, Number(value01) || 0));
    if (this.hasCapability(cap)) {
      const oldValue = this.getCapabilityValue(cap);

      this.setCapabilityValue(cap, normalizedValue).catch(err => {
        this.error(`Failed to set ${cap} to ${normalizedValue}:`, err);
      });

      if (oldValue === normalizedValue) return;

      const match = cap.match(/^dim\.ep(\d+)$/);
      if (match) {
        const endpointNum = parseInt(match[1], 10);

        const settings = this.getSettings();
        const customLabel = (settings[`label_ep${endpointNum}`] || '').trim();
        const isDimmer = this._endpointTypes[endpointNum] === WallWandDevice.DEVICE_TYPES.DIMMER;
        const defaultLabel = this._getDefaultLabel(endpointNum, isDimmer, cap);
        const endpointLabel = customLabel || defaultLabel;

        this.log(`Flow trigger for endpoint ${endpointNum} (${endpointLabel}) dim level changed to ${normalizedValue}`);

        const tokens = { endpoint_label: endpointLabel, dim: normalizedValue };
        const state = { endpoint: endpointNum };

        if (this.endpointDimTrigger) {
          this.endpointDimTrigger.trigger(this, tokens, state)
            .catch(this.error);
        }
      }
    }
  }
};


