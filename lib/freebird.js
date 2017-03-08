'use strict';

var path = require('path'),
    util = require('util'),
    EventEmitter = require('events');

var _ = require('busyman'),
    Objectbox = require('objectbox'),
    RPC = require('freebird-constants').RPC,
    BTM_EVTS = require('freebird-constants').EVENTS_FROM_BOTTOM;

var Agent = require('./rpc/agent.js'),
    validate = require('./utils/validate.js'),
    netmgmt = require('./components/netmgmt.js'),
    registry = require('./components/registry.js'),
    attachHandlers = require('./components/handlers.js'),
    FB_STATE = require('./utils/constants.js').FB_STATE;

/***********************************************************************/
/*** Freebird Class                                                  ***/
/***********************************************************************/
function Freebird(netcores, options) {
    // options: { maxDevNum: x, maxGadNum: y, dbPaths: { device, gadget } }
    if (!(this instanceof Freebird))
        return new Freebird(netcores, options);

    var self = this,
        options = options || {},
        devboxPath = path.resolve(__dirname, '../database/devices.db'),
        gadboxPath = path.resolve(__dirname, '../database/gadgets.db'),
        propWritable = { writable: true, enumerable: false, configurable: false },
        propUnwritable = { writable: false, enumerable: false, configurable: false };

    var maxDevNum = options.maxDevNum || 200,
        maxGadNum = options.maxGadNum || (3 * maxDevNum),
        devDbPath = (_.isObject(options.dbPaths) ? options.dbPaths.device : undefined) || devboxPath,
        gadDbPath = (_.isObject(options.dbPaths) ? options.dbPaths.gadget : undefined) || gadboxPath;

    if (maxGadNum < maxDevNum)
        throw new Error('Max gadget number cannot be less than max device number');

    netcores = _.isArray(netcores) ? netcores : [ netcores ];

    this.__ncNames = []; // For checking duplicated ncName, delete after checked

    _.forEach(netcores, function (nc, i) {
        var ncName;

        if (!validate.isNetcore(nc))
            throw new TypeError('Element of index ' + i + ' is not a valid netcore');

        nc._freebird = self;
        ncName = nc.getName();

        if (!_.includes(self.__ncNames, ncName))
            self.__ncNames.push(ncName);
        else
            throw new Error('Netcore name duplicates: ' + ncName);
    });

    this.__ncNames = null;
    delete this.__ncNames;

    EventEmitter.call(this);

    Object.defineProperty(this, '_netcores', _.assign({ value: netcores }, propUnwritable));
    Object.defineProperty(this, '_devbox', _.assign({ value: new Objectbox(devDbPath, maxDevNum) }, propWritable));
    Object.defineProperty(this, '_gadbox', _.assign({ value: new Objectbox(gadDbPath, maxGadNum) }, propWritable));
    Object.defineProperty(this, '_apiAgent', _.assign({ value: new Agent(self) }, propUnwritable));
    Object.defineProperty(this, '_state', _.assign({ value: FB_STATE.UNKNOW }, propWritable));
    Object.defineProperty(this, '_eventQueue', _.assign({ value: [] }, propWritable));
    Object.defineProperty(this, '_gadEventQueue', _.assign({ value: [] }, propWritable));

    attachHandlers(this);

    // Leave authenticate and authorize to rpc server implementer
}

util.inherits(Freebird, EventEmitter);

/***********************************************************************/
/*** Public Methods                                                  ***/
/***********************************************************************/
Freebird.prototype.addTransport = function (name, transp, callback) {
    if (!_.isString(name))
        throw new TypeError('name should be a string');

    this._apiAgent.addTransport(name, transp, callback);
};

Freebird.prototype.findById = function (type, id) {
    // type only accepts: 'netcore', 'device', 'gagdet'
    if (type === 'netcore')
        return _.find(this._netcores, function (nc) {
            return nc.getName() === id;
        });
    else if (type === 'device')
        return this._devbox.get(id);
    else if (type === 'gadget')
        return this._gadbox.get(id);
    else
        throw new TypeError('Unknow type: ' + type + ' to find with');
};

Freebird.prototype.findByNet = function (type, ncName, permAddr, auxId) {
    // type only accepts: 'netcore', 'device', 'gagdet'
    if (type === 'netcore')
        return _.find(this._netcores, function (nc) {
            return nc.getName() === ncName;
        });
    else if (type === 'device')
        return this._devbox.find(function (dev) {
            return (dev.get('permAddr') === permAddr) && (dev.get('netcore').getName() === ncName);
        });
    else if (type === 'gadget')
        return this._gadbox.find(function (gad) {
            return (gad.get('permAddr') === permAddr) && (gad.get('auxId') === auxId) && (gad.get('netcore').getName() === ncName);
        });
    else
        throw new TypeError('Unknow type: ' + type + ' to find with');
};

Freebird.prototype.filter = function (type, pred) {
    if (!_.isFunction(pred))
        throw new TypeError('pred should be a function');

    if (type === 'netcore')
        return _.filter(this._netcores, pred);
    else if (type === 'device')
        return this._devbox.filter(pred);
    else if (type === 'gadget')
        return this._gadbox.filter(pred);
    else
        throw new TypeError('Unknow type: ' + type + ' to find with');
};

/***********************************************************************/
/*** Public Methods: Registeration and Network Management            ***/
/***********************************************************************/
Freebird.prototype.register = registry.register;

Freebird.prototype.unregister = registry.unregister;

Freebird.prototype.start = netmgmt.start;

Freebird.prototype.stop = netmgmt.stop;

Freebird.prototype.reset = netmgmt.reset;

Freebird.prototype.permitJoin = netmgmt.permitJoin;

Freebird.prototype.remove = netmgmt.remove;

Freebird.prototype.ban = netmgmt.ban;

Freebird.prototype.unban = netmgmt.unban;

Freebird.prototype.ping = netmgmt.ping;

Freebird.prototype.maintain = netmgmt.maintain;

/***********************************************************************/
/*** Protected Methods                                               ***/
/***********************************************************************/
Freebird.prototype._normalFire = function (evt, data) {
    var self = this;
            
    if (evt === BTM_EVTS.NcDevIncoming)
        process.nextTick(function () { self.emit(evt, data);});
    else
        setImmediate(function () { self.emit(evt, data);});
};

Freebird.prototype._lazyFire = function (evt, data) {
    this._eventQueue.push({ name: evt, msg: data});
};

Freebird.prototype._fire = Freebird.prototype._normalFire;

Freebird.prototype._tweet = function (subsys, indType, id, data) {  // Send RPC indications
    var self = this,
        ind = { __intf: 'IND', subsys: null, type: indType, id: id, data: data };

    if (subsys === 'net' || subsys === RPC.Subsys.net)
        ind.subsys = RPC.Subsys.net;
    else if (subsys === 'dev' || subsys === RPC.Subsys.dev)
        ind.subsys = RPC.Subsys.dev;
    else if (subsys === 'gad' || subsys === RPC.Subsys.gad)
        ind.subsys = RPC.Subsys.gad;

    setImmediate(function () {
        self._apiAgent.indicate(ind, function (err) {
            if (err)
                self._fire('warn', err);
        });
    });
};

Freebird.prototype._setState = function (state) {
    this._state = state;
};

Freebird.prototype._getState = function (state) {
    return this._state;
};

Freebird.prototype._changeFireMode = function (mode) {  // 0: lazy, 1: normal
    mode = !!mode;
    
    if (mode === true) {
        if (this._eventQueue.length !== 0) {
            setImmediate(keepReleasing.bind(this));
        } else {
            this._fire = this._normalFire;
        }   
    } else {
        this._fire = this._lazyFire;
    }

    function keepReleasing() {
        var evtObj;

        if (this._eventQueue.length !== 0) {
            evtObj = this._eventQueue.shift();
            this.emit(evtObj.name, evtObj.msg);
            setImmediate(keepReleasing.bind(this));
        } else {
            this._fire = this._normalFire;
        }   
    }
};

Freebird.prototype._clearEventQueue = function () {
    this._eventQueue.length = 0;
};

module.exports = Freebird;
