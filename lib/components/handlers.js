// netcore event handlers
'use strict';
var validate;

var _ = require('busyman'),
    FBase = require('freebird-base'),
    FreebirdConsts = require('freebird-constants');

var utils = require('../utils/utils');

var EVT_TOP = FreebirdConsts.EVENTS_TO_TOP,
    EVT_BTM = FreebirdConsts.EVENTS_FROM_BOTTOM;

var handlers = {};

// all 'this' in the handler fuctions will be bound to freebird
/***********************************************************************/
/*** Netcore Event Listeners                                         ***/
/***********************************************************************/
handlers.ncError = function (errMsg) {  // errMsg = { ncName, error }
    this._fire(EVT_TOP.ERROR, errMsg.error/*.message*/);

    this._tweet('net', 'error', 0, {
        netcore: errMsg.ncName,
        message: errMsg.error.message
    });
};

handlers.ncEnabled = function (msg) {       // { ncName }
    this._fire(EVT_TOP.NC_ENABLED, msg);
    this._tweet('net', 'enabled', 0, { netcore: msg.ncName });
};

handlers.ncDisabled = function (msg) {      // { ncName }
    this._fire(EVT_TOP.NC_DISABLED, msg);
    this._tweet('net', 'disabled', 0, { netcore: msg.ncName });
};

handlers.ncStarted = function (msg) {       // { ncName }
    this._fire(EVT_TOP.NC_STARTED, msg);
    this._tweet('net', 'started', 0, { netcore: msg.ncName });
};

handlers.ncStopped = function (msg) {       // { ncName }
    this._fire(EVT_TOP.NC_STOPPED, msg);
    this._tweet('net', 'stopped', 0, { netcore: msg.ncName });
};

/***********************************************************************/
/*** tackle device and gadget incoming, leaving, and reporting       ***/
/***********************************************************************/
// v => ncNetReady
handlers.ncReady = function (msg) {         // { ncName }
    // No tweeting

    // this._tweet(EVT_TOP.NET_READY, msg);

    // this._tweet('net', 'stopped', 0, {
    //     netcore: msg.netcore.getName()
    // });

    // [TODO]
};

handlers.ncPermitJoin = function (msg) {    // { ncName, timeLeft }
    this._fire(EVT_TOP.NC_PERMIT_JOIN, msg);
    this._tweet('net', 'permitJoining', 0, { netcore: msg.ncName, timeLeft: msg.timeLeft });
};

handlers.ncDevIncoming = function (msg) {   // { ncName, permAddr, raw: rawDev }
    var freebird = this,
        nc = this.findByNet('netcore', msg.ncName),
        dev, devIn;

    function queueEvent(gadMsgIn) {
        var isEventExist = _.some(freebird._gadEventQueue, function (gadMsg) {
            return gadMsg.ncName === gadMsgIn.ncName && gadMsg.permAddr === gadMsgIn.permAddr && gadMsg.auxId === gadMsgIn.auxId;
        });

        if (isEventExist) {
            _.remove(freebird._gadEventQueue, function (gadMsg) {
                return gadMsg.ncName === gadMsgIn.ncName && gadMsg.permAddr === gadMsgIn.permAddr && gadMsg.auxId === gadMsgIn.auxId;
            });
        } else {
            freebird._gadEventQueue.push(gadMsgIn);    
        }
    }

    freebird.on(EVT_BTM.NcGadIncoming, queueEvent);

    function releasQueueEvent() {
        var evt = _.remove(freebird._gadEventQueue, function (gadMsg) {
                return gadMsg.ncName === msg.ncName && gadMsg.permAddr === msg.permAddr;
            });

        if (evt.length !== 0) {
            _.forEach(evt, function (msg) {
                freebird.emit(EVT_BTM.NcGadIncoming, msg);
            });
        } 
    }

    if (!nc)
        return;

    dev = freebird.findByNet('device', msg.ncName, msg.permAddr);
    devIn = FBase.createDevice(nc, msg.raw);

    nc.cookRawDev(devIn, msg.raw, function (err, brewedDev) {
        if (err)
            return freebird._tweet('net', 'error', 0, {
                netcore: msg.ncName,
                message: err.message
            });

        devIn = brewedDev;

        if (dev) {  // dev already exists, no need to fire EVT_TOP.DEV_INCOMING
            var netInfo = devIn.get('net');
            freebird.removeListener(EVT_BTM.NcGadIncoming, queueEvent);
            dev._poke();
            dev.set('_raw', devIn.get('raw'));      // should call set('_raw', raw) to reset raw (safe for recoverd device)
            dev.extra = devIn.extra;                // should assign extra (safe for recoverd device)

            dev.set('net', {                        // set('net', info) will find out network changes and report
                role: netInfo.role,
                parent: netInfo.parent,
                maySleep: netInfo.maySleep,
                sleepPeriod: netInfo.sleepPeriod,
                address: netInfo.address
            });
            dev.set('attrs', devIn.get('attrs'));   // set('attrs', attrs) will find out attribute changes and report
            dev.set('net', { status: 'online' });
        } else if (nc.isJoinable()) {
            freebird.register('device', devIn, function (err, id) {   // joinTime tagged in freebird.register('device')
                freebird.removeListener(EVT_BTM.NcGadIncoming, queueEvent);

                if (err) {
                    devIn = null;
                    freebird._tweet('net', 'error', 0, {
                        netcore: msg.ncName,
                        message: err.message
                    });
                } else {
                    devIn.enable();
                    devIn._poke();
                    devIn.set('net', { status: 'online' });

                    freebird._fire(EVT_TOP.DEV_INCOMING, { ncName: msg.ncName, permAddr: msg.permAddr, id: devIn.get('id'), device: devIn });
                    freebird._tweet('dev', 'devIncoming', devIn.get('id'), utils.dumpDeviceInfo(devIn));
                    releasQueueEvent();
                }
            });
        } else {
            freebird.removeListener(EVT_BTM.NcGadIncoming, queueEvent);
            return; // do nothing if netcore is not allowed for joining
        }
    });
};

handlers.ncDevLeaving = function (msg) {   // { ncName, permAddr }
    var freebird = this,
        nc = freebird.findByNet('netcore', msg.ncName),
        dev = freebird.findByNet('device', msg.ncName, msg.permAddr),
        devId,
        gad,
        gadTbl;

    if (!dev)
        return; // dev not found, do nothing

    dev._poke();
    devId = dev.get('id');
    dev.set('net', { status: 'offline' });          // 'netChanged', 'statusChanged'

    if (dev._removing) {                            // manually remove, should unregister all things
        gadTbl = dev.get('gadTable').map(function (rec) {
            return freebird.findById('gadget', rec.gadId);
        });

        removeGadget();
    }

    function removeGadget() {
        var gad, gadId, auxId;

        if (gadTbl.length === 0) {
            // remove device
            freebird.unregister('device', dev, function (err) {
                if (!err) {
                    freebird._fire(EVT_TOP.DEV_LEAVING, { ncName: msg.ncName, permAddr: msg.permAddr, id: devId });
                    freebird._tweet('dev', 'devLeaving', devId, { netcore: msg.ncName, permAddr: msg.permAddr });
                } else {
                    freebird._fire('warn', err);
                    freebird._tweet('dev', 'error', devId, { netcore: msg.ncName, message: err.message });
                }
            });
        } else {
            gad = gadTbl.pop();
            if (!gad)
                return removeGadget();

            gadId = gad.get('id');
            auxId = gad.get('auxId');

            freebird.unregister('gadget', gad, function (err) {
                if (!err) {
                    freebird._fire(EVT_TOP.GAD_LEAVING, { ncName: msg.ncName, permAddr: msg.permAddr, auxId: auxId, id: gadId });
                    freebird._tweet('gad', 'gadLeaving', gadId, { netcore: msg.ncName, permAddr: msg.permAddr, auxId: auxId });
                } else {
                    freebird._fire('warn', err);
                    freebird._tweet('gad', 'error', gadId, { netcore: msg.ncName, message: err.message });
                }

                removeGadget();
            });
        }
    }
};

handlers.ncDevNetChanging = function (msg) {    // { ncName, permAddr, data: changes }
    var dev = this.findByNet('device', msg.ncName, msg.permAddr);

    if (dev)
        dev.set('net', msg.data);   // device will check changes and then fire event: EVT_TOP.DevNetChanged
};

handlers.ncDevReporting = function (msg) {      // { ncName, permAddr, data: devAttrs }
    var freebird = this,
        dev = freebird.findByNet('device', msg.ncName, msg.permAddr),
        devId;

    if (!dev)
        return;

    devId = dev.get('id');

    dev._poke();
    dev.set('net', { status: 'online' });
    dev.set('attrs', msg.data);             // 'attrsChanged'

    freebird._fire(EVT_TOP.DEV_REPORTING, { ncName: msg.ncName, permAddr: msg.permAddr, id: devId, data: msg.data });
    // no need to tweet
};

handlers.ncGadIncoming = function (msg) {  // { ncName, permAddr, auxId, raw: rawGad }
    var freebird = this,
        ncName = msg.ncName,
        nc =  freebird.findByNet('netcore', ncName),
        dev = freebird.findByNet('device', ncName, msg.permAddr),
        gad = freebird.findByNet('gadget', ncName, msg.permAddr, msg.auxId),
        gadIn,
        doGadCook,
        syncTimes = 0;

    if (!dev)
        return; // device not found, ignore this gad incoming

    freebird._gadEventQueue.push(msg);
    dev._poke();
    dev.set('net', { status: 'online' });

    gadIn = FBase.createGadget(dev, msg.auxId, msg.raw);

    doGadCook = function () {
        // This is used to sync gadIncoming
        if (_.isNil(dev.get('id'))) {
            if (++syncTimes > 50) // try resync for 1 second, discard this gadIncoming message if fails
                return;

            return setTimeout(function () {
                doGadCook();
            }, 20);
        }

        nc.cookRawGad(gadIn, msg.raw, function (err, brewedGad) {
            _.remove(freebird._gadEventQueue, function (gadMsg) {
                return gadMsg.ncName === msg.ncName && gadMsg.permAddr === msg.permAddr && gadMsg.auxId === msg.auxId;
            });

            if (err)
                return freebird._tweet('net', 'error', 0, {
                    netcore: msg.ncName,
                    message: err.message
                });

            gadIn = brewedGad;

            if (gad) {
                gad.set('_raw', gadIn.get('raw'));
                gad.extra = gadIn.extra;
                gad.set('panel', gadIn.get('panel'));   // 'panelChanged'
                gad.set('attrs', gadIn.get('attrs'));   // 'attrsChanged'

                if (gad.get('props').name === 'unknown')
                    gad.set('props', { name: gadIn.get('panel').classId }); 

            } else if (nc.isJoinable()) {
                freebird.register('gadget', gadIn, function (err, id) {
                    if (err) {
                        gadIn = null;
                        freebird._fire('warn', err);
                        freebird._tweet('gad', 'error', 0, { netcore: ncName, message: err.message});
                    } else {
                        gadIn.enable();

                        if (gadIn.get('props').name === 'unknown')
                            gadIn.set('props', { name: gadIn.get('panel').classId }); 

                        freebird._fire(EVT_TOP.GAD_INCOMING, { ncName: msg.ncName, permAddr: msg.permAddr, auxId: msg.auxId, id: gadIn.get('id'), gadget: gadIn });
                        freebird._tweet('gad', 'gadIncoming', gadIn.get('id'), utils.dumpGadgetInfo(gadIn));
                    }
                });
            }
        });
    };

    doGadCook();
};

handlers.ncGadReporting = function (msg) { // { ncName, permAddr, auxId, data: gadAttrs, [appendFlag] }
    var freebird = this,
        ncName = msg.ncName,
        dev = freebird.findByNet('device', ncName, msg.permAddr),
        gad = freebird.findByNet('gadget', ncName, msg.permAddr, msg.auxId);

    if (!dev)
        return;

    dev._poke();
    dev.set('net', { status: 'online' });

    if (!gad)
        return;

    if (!msg.appendFlag)
        gad.set('attrs', msg.data);             // 'attrsChanged'
    else 
        gad._dangerouslyAppendAttrs(msg.data);  // 'attrsAppend'

    freebird._fire(EVT_TOP.GAD_REPORTING, { ncName: msg.ncName, permAddr: msg.permAddr, auxId: msg.auxId, id: gad.get('id'), data: msg.data });
    freebird._tweet('gad', 'attrsReport', gad.get('id'), msg.data);
};

/***********************************************************************/
/*** tackle banned device and gadget events                          ***/
/***********************************************************************/
handlers.ncBannedDevIncoming = function (msg) {
    return bannedComponent(this, 'device', 'bannedIncoming', msg);
};

handlers.ncBannedDevReporting = function (msg) {
    return bannedComponent(this, 'device', 'bannedReport', msg);
};

handlers.ncBannedGadIncoming = function (msg) {
    return bannedComponent(this, 'gadget', 'bannedIncoming', msg);
};

handlers.ncBannedGadReporting = function (msg) {
    return bannedComponent(this, 'gadget', 'bannedReport', msg);
};

/***********************************************************************/
/*** tackle response event of netcore command                        ***/
/***********************************************************************/
handlers.ncNetBan = function (msg) {        // { netcore, permAddr }
    var fb = this,
        ncName = msg.ncName,
        permAddr = msg.permAddr,
        nc = fb.findByNet('netcore', ncName),
        dev = fb.findByNet('device', ncName, permAddr);

    if (dev) {
        nc.remove(permAddr, function (err) {
            if (err) {
                fb._fire('warn', err);
                fb._tweet('dev', 'error', dev.get('id'), { netcore: ncName, message: err.message});
            }
        });
    }
};

handlers.ncNetUnban = function (msg) {
    // do nothing
};

handlers.ncNetPing = function (msg) {
    // do nothing
};

/***********************************************************************/
/*** device and gadget events: instance has been changed             ***/
/***********************************************************************/
handlers.devError = function (msg) {       // { ncName, error, id }
    this._fire('warn', msg.error);
    this._tweet('dev', 'error', msg.id, { netcore: msg.ncName, message: msg.error.message});
};

handlers.devNetChanged = function (msg) {
    return updateComponent(this, 'dev', 'net', msg);
};

handlers.devPropsChanged = function (msg) {
    return updatePropsComponent(this, 'dev', msg);
};

handlers.devAttrsChanged = function (msg) {
    return updateComponent(this, 'dev', 'attrs', msg);
};

handlers.devRead = function (msg) {
    // do nothing
};

handlers.devWrite = function (msg) {
    // do nothing
};

handlers.devIdentify = function (msg) {
    // do nothing
};

handlers.gadError = function (msg) {       // { ncName, error, id }
    this._fire('warn', msg.error);
    this._tweet('gad', 'error', msg.id, { netcore: msg.ncName, message: msg.error.message});
};

handlers.gadPanelChanged = function (msg) {
    return updateComponent(this, 'gad', 'panel', msg);
};

handlers.gadPropsChanged = function (msg) {
    return updatePropsComponent(this, 'gad', msg);
};

handlers.gadAttrsChanged = function (msg) {
    return updateComponent(this, 'gad', 'attrs', msg);
};

handlers.gadAttrsAppend = function (msg) {
    // msg: { ncName, permAddr, auxId, id, data: attrs }
    var fb = this,
        ncName = msg.ncName,
        id = msg.id,
        attrs = msg.data;

    this._gadbox.replace(id, 'attrs', attrs, function (err) {
        if (err) {
            fb._fire('warn', err);
            fb._tweet('gad', 'error', id, { netcore: ncName, message: err.message});
        } else {
            fb._fire(EVT_TOP.GAD_ATTRS_CHANGED, msg);
            fb._tweet('gad', 'attrsChanged', id, attrs);
        }
    });
};

handlers.gadRead = function (msg) {
    // do nothing
};

handlers.gadWrite = function (msg) {
    // do nothing
};

handlers.gadExec = function (msg) {
    // do nothing
};

handlers.gadReadReportCfg = function (msg) {
    // do nothing
};

handlers.gadWriteReportCfg = function (msg) {
    // do nothing
};

handlers.gadPanelChangedDisabled = function (msg) {
    // do nothing
};

/***********************************************************************/
/*** Private Functions                                               ***/
/***********************************************************************/
function bannedComponent(fb, type, indType, msg, cb) {
    // { ncName, permAddr, raw: rawDev }        - bannedDevIncoming
    // { ncName, permAddr, auxId, raw: rawGad } - bannedGadIncoming
    // { ncName, permAddr, data: attrs }        - bannedDevReporting
    // { ncName, permAddr, auxId, data: attrs } - bannedGadReporting

    var nc = fb.findByNet('netcore', msg.ncName),
        ncName = msg.ncName,
        permAddr = msg.permAddr,
        // upMsg = { netcore: nc, permAddr: permAddr },
        evtName = getBannedEventName(type, indType),
        component,
        componentId;

    if (type === 'device') {
        component = fb.findByNet(type, ncName, permAddr);
        componentId = component ? component.get('id') : 0;

        fb._fire(evtName, { ncName: msg.ncName, permAddr: msg.permAddr });
        fb._tweet('dev', evtName, componentId, { netcore: msg.ncName, permAddr: msg.permAddr });

        if (component) {
            nc.remove(permAddr, function (err) {
                if (err) {
                    fb._fire('warn', err);
                    fb._tweet('dev', 'error', component.get('id'), { netcore: ncName, message: err.message});
                }
            });
        }
    } else if (type === 'gadget') {
        component = fb.findByNet(type, ncName, permAddr, msg.auxId);
        componentId = component ? component.get('id') : 0;

        fb._fire(evtName, { ncName: msg.ncName, permAddr: msg.permAddr, auxId: msg.auxId });
        fb._tweet('gad', evtName, componentId, { netcore: msg.ncName, permAddr: msg.permAddr, auxId: msg.auxId });

        if (component) {
            var gadId = component.get('id');

            fb.unregister('gadget', component, function (err) {
                if (!err) {
                    fb._fire(EVT_TOP.GAD_LEAVING, { ncName: msg.ncName, permAddr: msg.permAddr, auxId: msg.auxId, id: gadId });
                    fb._tweet('gad', 'gadLeaving', gadId, { netcore: msg.ncName, permAddr: msg.permAddr, auxId: msg.auxId });
                } else {
                    fb._fire('warn', err);
                    fb._tweet('gad', 'error', gadId, { netcore: msg.ncName, message: err.message });
                }
            });
        }
    }

    if (_.isFunction(cb))
        cb();
}

function getBannedEventName(type, indType) {
    var evt;

    if (type === 'device') {
        if (indType === 'bannedReport')
            evt = EVT_TOP.DEV_BAN_REPORTING;
        else if (indType === 'bannedIncoming')
            evt = EVT_TOP.DEV_BAN_INCOMING;
    } else if (type === 'gadget') {
        if (indType === 'bannedReport')
            evt = EVT_TOP.GAD_BAN_REPORTING;
        else if (indType === 'bannedIncoming')
            evt = EVT_TOP.GAD_BAN_INCOMING;
    }
    return evt;
}

function updateComponent(fb, type, namespace, msg, cb) {
    // type = 'dev', msg: { ncName, permAddr, id, data: delta, _data: oldVal }
    // type = 'gad' ,msg: { ncName, permAddr, auxId, id, data: delta, _data: oldVal }
    var ncName = msg.ncName,
        id = msg.id,
        delta = msg.data,
        evtName = getUpdateEventName(type, namespace),
        box = type === 'dev' ? fb._devbox : fb._gadbox;

    box.modify(id, namespace, delta, function (err, diff) {
        if (err) {
            fb._fire('warn', err);
            fb._tweet(type, 'error', id, { netcore: ncName, message: err.message});
        } else {
            fb._fire(evtName, msg);
            fb._tweet(type, namespace + 'Changed', msg.id, delta);

            if (evtName === EVT_TOP.DEV_NET_CHANGED && delta.status) {

                fb._fire(EVT_TOP.DEV_STATUS_CHANGED, { ncName: msg.ncName, permAddr: msg.permAddr, id: msg.id, data: { status: delta.status } });
                fb._tweet('dev', 'statusChanged', msg.id, { status: delta.status });
            }
        }

        if (_.isFunction(cb))
            cb(err, diff);
    });
}

function updatePropsComponent(fb, type, msg, cb) {
    // type = 'dev', msg: { ncName, permAddr, id, data: delta, _data: oldVal }
    // type = 'gad' ,msg:  { ncName, permAddr, auxId, id, data: delta, _data: oldVal }
    var ncName = msg.ncName,
        id = msg.id,
        delta = msg.data,
        evtName = getUpdateEventName(type, 'props'),
        box = type === 'dev' ? fb._devbox : fb._gadbox,
        component = type === 'dev' ? fb.findById('device', id) : fb.findById('gadget', id),
        newProps;

    if (!component)
        return;

    newProps = component.get('props');

    box.replace(id, 'props', newProps, function (err) {
        if (err) {
            fb._fire('warn', err);
            fb._tweet(type, 'error', id, { netcore: ncName, message: err.message});
        } else {
            fb._fire(evtName, msg);
            fb._tweet(type, 'propsChanged', msg.id, delta);
        }

        if (_.isFunction(cb))
            cb(err, delta);
    });
}

function getUpdateEventName(type, namespace) {
    var evtName;

    if (type === 'dev') {
        if (namespace === 'net')
            evtName = EVT_TOP.DEV_NET_CHANGED;
        else if (namespace === 'props')
            evtName = EVT_TOP.DEV_PROPS_CHANGED;
        else if (namespace === 'attrs')
            evtName = EVT_TOP.DEV_ATTRS_CHANGED;
    } else if (type === 'gad') {
        if (namespace === 'panel')
            evtName = EVT_TOP.GAD_PANEL_CHANGED;
        else if (namespace === 'props')
            evtName = EVT_TOP.GAD_PROPS_CHANGED;
        else if (namespace === 'attrs')
            evtName = EVT_TOP.GAD_ATTRS_CHANGED;
    }

    return evtName;
}

module.exports = function attachEventListeners(freebird) {
    var ncLsns = freebird._ncEventListeners = freebird._ncEventListeners || {};

    freebird.removeAllListeners(EVT_BTM.NcError)
            .removeAllListeners(EVT_BTM.NcEnabled)
            .removeAllListeners(EVT_BTM.NcDisabled)
            .removeAllListeners(EVT_BTM.NcStarted)
            .removeAllListeners(EVT_BTM.NcStopped)
            .removeAllListeners(EVT_BTM.NcReady)
            .removeAllListeners(EVT_BTM.NcPermitJoin)
            .removeAllListeners(EVT_BTM.NcDevIncoming)
            .removeAllListeners(EVT_BTM.NcDevLeaving)
            .removeAllListeners(EVT_BTM.NcDevNetChanging)
            .removeAllListeners(EVT_BTM.NcDevReporting)
            .removeAllListeners(EVT_BTM.NcGadIncoming)
            .removeAllListeners(EVT_BTM.NcGadReporting)
            .removeAllListeners(EVT_BTM.NcBannedDevIncoming)
            .removeAllListeners(EVT_BTM.NcBannedDevReporting)
            .removeAllListeners(EVT_BTM.NcBannedGadIncoming)
            .removeAllListeners(EVT_BTM.NcBannedGadReporting)
            .removeAllListeners(EVT_BTM.DevError)
            .removeAllListeners(EVT_BTM.DevNetChanged)
            .removeAllListeners(EVT_BTM.DevPropsChanged)
            .removeAllListeners(EVT_BTM.DevAttrsChanged)
            .removeAllListeners(EVT_BTM.GadError)
            .removeAllListeners(EVT_BTM.GadPanelChanged)
            .removeAllListeners(EVT_BTM.GadPropsChanged)
            .removeAllListeners(EVT_BTM.GadAttrsChanged)
            .removeAllListeners(EVT_BTM.GadAttrsAppend);

    // Firstly bind the handlers to freebird
    _.forEach(handlers, function (lsn, key) {
        ncLsns[key] = lsn.bind(freebird);
    });

    // Then, attach the handlers to events                                  // VVVVVVVVVVVVVVVVVVVVVV [TODO] all kvps need to be checked
    freebird.on(EVT_BTM.NcError, ncLsns.ncError);                           // { ncName, error: err }
    freebird.on(EVT_BTM.NcEnabled, ncLsns.ncEnabled);
    freebird.on(EVT_BTM.NcDisabled, ncLsns.ncDisabled);
    freebird.on(EVT_BTM.NcStarted, ncLsns.ncStarted);
    freebird.on(EVT_BTM.NcStopped, ncLsns.ncStopped);
    freebird.on(EVT_BTM.NcReady, ncLsns.ncReady);                           // { ncName }
    freebird.on(EVT_BTM.NcPermitJoin, ncLsns.ncPermitJoin);                 // { ncName, timeLeft: self._joinTicks }

    freebird.on(EVT_BTM.NcDevIncoming, ncLsns.ncDevIncoming);               // { ncName, permAddr: permAddr, raw: rawDev }
    freebird.on(EVT_BTM.NcDevLeaving, ncLsns.ncDevLeaving);                 // { ncName, permAddr: permAddr }
    freebird.on(EVT_BTM.NcDevNetChanging, ncLsns.ncDevNetChanging);         // { ncName, permAddr: permAddr, data: changes }
    freebird.on(EVT_BTM.NcDevReporting, ncLsns.ncDevReporting);             // { ncName, permAddr: permAddr, data: devAttrs }

    freebird.on(EVT_BTM.NcGadIncoming, ncLsns.ncGadIncoming);               // { ncName, permAddr: permAddr, auxId: auxId, raw: rawGad }
    freebird.on(EVT_BTM.NcGadReporting, ncLsns.ncGadReporting);             // { ncName: this, permAddr: permAddr, auxId: auxId, data: gadAttrs }

    freebird.on(EVT_BTM.NcBannedDevIncoming, ncLsns.ncBannedDevIncoming);   // { ncName, permAddr: permAddr, raw: rawDev }
    freebird.on(EVT_BTM.NcBannedDevReporting, ncLsns.ncBannedDevReporting); // { ncName, permAddr: permAddr, data: devAttrs }

    freebird.on(EVT_BTM.NcBannedGadIncoming, ncLsns.ncBannedGadIncoming);   // { ncName, permAddr: permAddr, auxId: auxId, raw: rawGad }
    freebird.on(EVT_BTM.NcBannedGadReporting, ncLsns.ncBannedGadReporting); // { ncName: this, permAddr: permAddr, auxId: auxId, data: gadAttrs }

    freebird.on(EVT_BTM.NcNetBan, ncLsns.ncNetBan);                         // { ncName, permAddr: permAddr }
    freebird.on(EVT_BTM.NcNetUnban, ncLsns.ncNetUnban);                     // { ncName, permAddr: permAddr }
    freebird.on(EVT_BTM.NcNetPing, ncLsns.ncNetPing);                       // { ncName, permAddr: permAddr, data: time }

    freebird.on(EVT_BTM.DevError, ncLsns.devError);                         // { ncName, error: err }
    freebird.on(EVT_BTM.DevNetChanged, ncLsns.devNetChanged);               // { ncName, data: delta }, setNetInfo
    freebird.on(EVT_BTM.DevPropsChanged, ncLsns.devPropsChanged);           // { ncName, data: delta }, setProps
    freebird.on(EVT_BTM.DevAttrsChanged, ncLsns.devAttrsChanged);           // { ncName, data: delta }, setAttrs

    freebird.on(EVT_BTM.DevRead, ncLsns.devRead);                           // { ncName, permAddr: permAddr, data: result }
    freebird.on(EVT_BTM.DevWrite, ncLsns.devWrite);                         // { ncName, permAddr: permAddr, data: result }
    freebird.on(EVT_BTM.DevIdentify, ncLsns.devIdentify);                   // { ncName, permAddr: permAddr }

    freebird.on(EVT_BTM.GadError, ncLsns.gadError);                         // { id, error: err }
    freebird.on(EVT_BTM.GadPanelChanged, ncLsns.gadPanelChanged);           // { id, data: delta }, setPanelInfo
    freebird.on(EVT_BTM.GadPropsChanged, ncLsns.gadPropsChanged);           // { id, data: delta }, setProps
    freebird.on(EVT_BTM.GadAttrsChanged, ncLsns.gadAttrsChanged);           // { id, data: delta }, setAttrs
    freebird.on(EVT_BTM.GadAttrsAppend, ncLsns.gadAttrsAppend);             // { id, data: attrs }, _dangerouslySetAttrs

    freebird.on(EVT_BTM.GadRead, ncLsns.gadRead);                           // { ncName, permAddr: permAddr, auxId: auxId, data: result }
    freebird.on(EVT_BTM.GadWrite, ncLsns.gadWrite);                         // { ncName, permAddr: permAddr, auxId: auxId, data: result }
    freebird.on(EVT_BTM.GadExec, ncLsns.gadExec);                           // { ncName, permAddr: permAddr, auxId: auxId, data: result }
    freebird.on(EVT_BTM.GadReadReportCfg, ncLsns.gadReadReportCfg);         // { ncName, permAddr: permAddr, auxId: auxId, data: result }
    freebird.on(EVT_BTM.GadWriteReportCfg, ncLsns.gadWriteReportCfg);       // { ncName, permAddr: permAddr, auxId: auxId, data: result }
    freebird.on(EVT_BTM.GadPanelChangedDisabled, ncLsns.gadPanelChangedDisabled);
};

// [TODO] HOW TO DEAL WITH ERROR MESSAGES?