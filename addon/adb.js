/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

/* Fake require statements so that the module dependency graph has web workers
  require("adb/adb-server-thread.js");
  require("adb/adb-io-thread.js");
  require("adb/adb-utility-thread.js");
  require("adb/adb-device-poll-thread.js");
  require("adb/adb-io-thread-spawner.js");
  require("adb/ctypes-bridge-builder.js");
  require("adb/worker-console.js");
  require("adb/js-message.js");
  require("adb/common-message-handler.js");
 */

const { Cc, Ci, Cr, Cu, ChromeWorker } = require("chrome");
const promise = require("sdk/core/promise");

const URL_PREFIX = module.uri.replace(/adb\.js/, "");
const WORKER_URL_SERVER = URL_PREFIX + "adb-server-thread.js";
const WORKER_URL_IO = URL_PREFIX + "adb-io-thread.js";
const WORKER_URL_UTIL = URL_PREFIX + "adb-utility-thread.js";
const WORKER_URL_DEVICE_POLL = URL_PREFIX + "adb-device-poll-thread.js";
const WORKER_URL_IO_THREAD_SPAWNER = URL_PREFIX + "adb-io-thread-spawner.js";

const EventedChromeWorker = require("adb/evented-chrome-worker").EventedChromeWorker;
const deviceTracker = require("adb/adb-device-tracker");
const fileTransfer = require("adb/adb-file-transfer");
const commandRunner = require("adb/adb-command-runner");
const blockingNative = require("adb/adb-blocking-native");
const timers = require("sdk/timers");
const URL = require("sdk/url");
const env = require("sdk/system/environment").env;
const File = require("sdk/io/file");
const TmpD = require("sdk/system").pathFor("TmpD");

const self = require("sdk/self");
const { platform } = require("sdk/system");

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/ctypes.jsm");

let serverWorker, ioWorker, utilWorker;

let extension = (platform === "winnt") ? ".dll" : ".so";

let platformDir;
if (platform === "winnt") {
  platformDir = "win32";
} else if (platform === "linux") {
  let is64bit = (require("sdk/system/runtime").XPCOMABI.indexOf("x86_64") == 0);
  if (is64bit) {
    platformDir = "linux64";
  } else {
    platformDir = "linux";
  }
} else if (platform === "darwin") {
  platformDir = "mac64";
} else {
  throw "Unsupported platform";
}
let libPath = URL.toFilename(self.data.url(platformDir + "/adb/libadb" + extension));
let [driversPath, winusbPath] = (platform === "winnt") ?
  [URL.toFilename(self.data.url("win32/adb/AdbWinApi.dll")),
   URL.toFilename(self.data.url("win32/adb/AdbWinUsbApi.dll"))] : [null, null];

// the context is used as shared state between EventedChromeWorker runOnPeerThread calls and this module
let context = { __workers: [], // this array is populated automatically by EventedChromeWorker
                platform: platform,
                driversPath: driversPath,
                libPath: libPath,
                winusbPath: winusbPath
              };

const DEVICE_NOT_CONNECTED = "Device not connected";
exports.DEVICE_NOT_CONNECTED = DEVICE_NOT_CONNECTED;

let server_die_fd = null;
// make sure to only start shutting down if we haven't started a shutdown
let hasStartedShutdown = false;
// only restart once on fatal error to prevent infinite restart loop
let hasRestarted = false;

let ready = false;
let didRunInitially = false;

function queryService(service, deferred) {
  let result = "";
  utilWorker.emit("query", { service: service }, function({ fd }) {
    if (fd < 0) {
      console.error("Bad fd: " + fd);
      deferred.reject("Bad file descriptor");
      return;
    }

    let msg = service + ":data";
    let idx = ioWorker.listenAndForget(msg, function({ data }) {
      result += data;
    });

    ioWorker.emit("readStringFully", { fd: fd, tag: service }, function({ ret }) {
      ioWorker.freeListener(msg, idx);
      deferred.resolve(result);
    });

  });
}

exports = module.exports = {
  get didRunInitially() didRunInitially,
  set didRunInitially(newVal) { didRunInitially = newVal },
  get ready() ready,
  set ready(newVal) { ready = newVal },

  start: function start() {
    if (ready) {
      return;
    }
    let startedSuccessfully = this._startAdbInBackground();
    this.didRunInitially = startedSuccessfully;
  },


  push: function pushFile(srcPath, destPath) {
    let deferred = promise.defer();
    if (!deviceTracker.hasDevice) {
      deferred.reject(DEVICE_NOT_CONNECTED);
      return deferred.promise;
    }

    return fileTransfer.pushFile(srcPath, destPath);
  },

  trackDevices: function trackDevices() {
    // nop -- we automatically start tracking devices
  },

  forwardPort: function forwardPort(port, remote) {
    let deferred = promise.defer();
    if (!deviceTracker.hasDevice) {
      deferred.reject(DEVICE_NOT_CONNECTED);
      return deferred.promise;
    }

    // <host-prefix>:forward:<local>;<remote>
    let service = "host:forward:tcp:" + port + ";" + (remote || "tcp:6000");

    queryService(service, deferred);

    return deferred.promise;
  },

  shell: function shell(shellCommand) {
    let deferred = promise.defer();
    if (!deviceTracker.hasDevice) {
      deferred.reject(DEVICE_NOT_CONNECTED);
      return deferred.promise;
    }

    console.debug("Executing: adb " + shellCommand);

    let service = "shell:" + shellCommand;

    queryService(service, deferred);

    return deferred.promise;
  },

  listDevices: function listDevices() {
    return deviceTracker.listDevices();
  },

  close: function close() {
    if (hasStartedShutdown) {
      return;
    }
    hasStartedShutdown = true;
    ready = false;
    let t0 = Date.now();
    console.log("Closing ADB");
    let x = 1;
    console.debug("After stopTrackingDevices");

    blockingNative.killDeviceLoop();

    if (context.t_ptrS) {
      blockingNative.killIOPump(context.t_ptrS);
    }

    console.debug("killAck received");
    // this ioWorker writes to the die_fd which wakes of the fdevent_loop which will then die and return to JS
    let res = blockingNative.writeFully(server_die_fd, ctypes.int(0xDEAD), 4);
    console.debug("Finished writing to die_fd ret=" + JSON.stringify(res));
    blockingNative.waitForServerDeath();
    console.debug("Done waiting for server death");
    blockingNative.cleanupNativeCode();
    context.__workers.forEach(function(w) {
      console.debug("Killing Worker: " + w.tag)
      w.terminate();
    });
    context.__workers = [];
    console.debug("ALL workers are terminated");
    let t1 = Date.now();
    console.log("ADB closed in " + (t1 - t0) + "ms");
    deviceTracker.stop();
  }
};

context.close = exports.close;

function restart_helper() {
  context.restart = exports.restart;
}

function reset() {
  server_die_fd = null;
  context = { __workers: [], // this array is populated automatically by EventedChromeWorker
              platform: platform,
              driversPath: driversPath,
              libPath: libPath
            };
  restart_helper();

  deviceTracker.reset();
  fileTransfer.reset();
  commandRunner.reset();
  blockingNative.reset();
}

exports.restart = function restart() {
  console.debug("ADB wants to restart");
  exports.close();

  if (!hasRestarted) {
    console.debug("ADB is restarting");
    hasRestarted = true;
    // This timeout is temporarily here because native code routines need a
    // bit of extra time to close since they do not close fully synchronously.
    // More exploration is needed before this is resolved, but here is a general
    // overview of what might be going on:
    // Two of the threads in the native code are killed via I/O to a native
    // file descriptor sometime during the execution of the close method. One or
    // both of these threads does other things that make it not close
    // immediately after the native file descriptor write returns
    timers.setTimeout(function timeout() {
      reset();
      exports._startAdbInBackground();
    }, 200);
  } else {
    console.error("ADB fatally died!");
    Services.obs.notifyObservers(null, "adb-fatal-death", null);
  }
};
restart_helper();

exports._startAdbInBackground = function startAdbInBackground() {
  hasStartedShutdown = false;
  this.ready = true;

  // catch the exception that is thrown when the shared library cannot be loaded
  try {
    blockingNative.init(libPath, driversPath);
  } catch (e) {
    console.log(e);
    return false;
  }
  serverWorker = new EventedChromeWorker(WORKER_URL_SERVER, "server_thread", context);
  ioWorker = new EventedChromeWorker(WORKER_URL_IO, "io_thread", context);
  utilWorker = new EventedChromeWorker(WORKER_URL_UTIL, "util_thread", context);

  serverWorker.once("spawn-device-loop", function () {
    let devicePollWorker = new EventedChromeWorker(WORKER_URL_DEVICE_POLL, "device_poll_thread", context);
    devicePollWorker.emitAndForget("init", { libPath: context.libPath,
                                             driversPath: context.driversPath,
                                             platform: context.platform,
                                             winusbPath: context.winusbPath });
  });

  serverWorker.listen("spawn-io-threads", function ({ t_ptrS }) {
    // Store the transport pointer so the io pump can be killed if the library
    // is shutdown.
    context.t_ptrS = t_ptrS;
    let inputThread = new EventedChromeWorker(WORKER_URL_IO_THREAD_SPAWNER, "input_thread", context);
    inputThread.emitAndForget("init",
      { libPath: context.libPath,
        threadName: "device_input_thread",
        t_ptrS: t_ptrS,
        platform: context.platform,
        driversPath: context.driversPath
      });

    let outputThread = new EventedChromeWorker(WORKER_URL_IO_THREAD_SPAWNER, "output_thread", context);
    outputThread.emit("init",
      { libPath: context.libPath,
        threadName: "device_output_thread",
        t_ptrS: t_ptrS,
        platform: context.platform,
        driversPath: context.driversPath
      },
      function () {
        // The io pump is dead, no need to keep the transport pointer.
        context.t_ptrS = null;
      }
    );
  });

  deviceTracker.start(serverWorker);

  serverWorker.emit("init", { libPath: libPath }, function initack() {
    serverWorker.emit("start", { port: 5037, log_path: File.join(TmpD, "adb.log") }, function started(res) {
      console.debug("adb server thread returned: " + res.ret);
      if (res.ret == -1) {
        Services.obs.notifyObservers(null, "adb-port-in-use", null);
      }
    });
  });

  serverWorker.onceAndForget("kill-server-fd", function({ fd }) {
    server_die_fd = fd;
  });

  [ioWorker, utilWorker].forEach(function initworker(w) {
    w.emit("init", { libPath: libPath,
                     driversPath: context.driversPath,
                     platform: context.platform }, function initack() {
      console.debug("Inited worker");
    });
  });

  return true;
};

