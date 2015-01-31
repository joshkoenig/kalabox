'use strict';

// dependencies
var _ = require('lodash');
var async = require('async');
var chalk = require('chalk');
var fs = require('fs');
var path = require('path');

var kbox = require('../../lib/kbox.js');
var deps = kbox.core.deps;
var disk = kbox.util.disk;
var engine = kbox.engine;
var provider = kbox.engine.provider;
var services = kbox.services;
var download = kbox.util.download;
var firewall = kbox.util.firewall;
var internet = kbox.util.internet;
var cmd = kbox.install.cmd;
var sysProfiler = kbox.install.sysProfiler;
var vb = kbox.install.vb;

// constants
var INSTALL_MB = 30 * 1000;
// @todo: these will eventually come from the factory
var PROVIDER_INIT_ATTEMPTS = 3;
var PROVIDER_UP_ATTEMPTS = 3;
var KALABOX_DNS_PATH = '/etc/resolver';
var KALABOX_DNS_FILE = 'kbox';
var PROVIDER_URL_V1_4_1 =
  'https://github.com/boot2docker/osx-installer/releases/download/v1.4.1/' +
  'Boot2Docker-1.4.1.pkg';
var PROVIDER_URL_PROFILE =
  'https://raw.githubusercontent.com/' +
  'kalabox/kalabox-boot2docker/master/profile';
// variables
var adminCmds = [];
var providerIsInstalled;
var dnsIsSet;
var profileIsSet;
var firewallIsOkay;
var stepCounter = 1;

module.exports.run = function(done) {

  var log = {
    header: function(msg) {
      console.log('STEP [' + stepCounter + '] -- ' + msg + '...');
      stepCounter += 1;
    },
    alert: function(msg) {
      console.log(chalk.yellow(' ##### ' + msg + ' #####'));
    },
    info: function(msg) {
      console.log(chalk.gray(' --- ' + msg));
    },
    ok: function(msg) {
      console.log(chalk.green(' - ' + msg));
    },
    warn: function(msg) {
      console.log(chalk.red(' - ' + msg));
    },
    fail: function(msg) {
      console.log(chalk.red(' *** ' + msg + ' ***'));
      process.exit(1);
    },
    newline: function() { console.log(''); }
  };

  function sendMessage(msg) {
    console.log(msg);
  }

  function newline() { sendMessage(''); }

  function fail(msg) {
    console.log(chalk.red('*** ' + msg + ' ***'));
    process.exit(1);
  }

  async.series([

    // Check if boot2docker is already installed.
    // @todo: we should remove this in favor of provider.isInstalled()
    function(next) {
      log.header('Checking if Boot2Docker is installed.');
      sysProfiler.isAppInstalled('Boot2Docker', function(err, isInstalled) {
        if (err) {
          throw err;
        }
        var msg = isInstalled ? 'is' : 'is NOT';
        log.info('Boot2Docker ' + msg + ' installed.');
        log.newline();
        providerIsInstalled = isInstalled;
        next(null);
      });
    },

    // Check if profile is already set.
    function(next) {
      log.header('Checking for KBOX Boot2Docker profile.');
      profileIsSet = fs.existsSync(
        path.join(deps.lookup('config').sysConfRoot, 'b2d.profile')
      );
      var msg = profileIsSet ? 'exists.' : 'does NOT exist.';
      log.info('Boot2Docker profile ' + msg);
      log.newline();
      next(null);
    },

    // Check if VirtualBox.app is running.
    function(next) {
      log.header('Checking if VirtualBox is running.');
      vb.isRunning(function(err, isRunning) {
        if (err) {
          throw err;
        }
        if (isRunning) {
          log.info('VirtualBox: is currently running.');
        } else {
          log.info('VirtualBox: is NOT currently running.');
        }
        log.newline();
        next();
      });
    },

    // Check the firewall settings.
    function(next) {
      log.header('Checking firewall settings.');
      firewall.isOkay(function(isOkay) {
        var msg = isOkay ? 'OK' : 'NOT OK';
        var fnLog = isOkay ? log.info : log.fail;
        fnLog('Firewall settings: ' + msg);
        log.newline();
        firewallIsOkay = isOkay;
        next(null);
      });
    },

    // Check for access to the internets.
    function(next) {
      log.header('Checking internet access.');
      internet.check('www.google.com', function(err) {
        var msg = err === null ? 'OK' : 'NOT OK';
        var fnLog = err === null ? log.info : log.warn;
        fnLog('Internet access: ' + msg);
        if (err !== null) {
          log.fail('Internet is NOT accessable!');
        }
        newline();
        next(null);
      });
    },

    // Check available disk space for install.
    function(next) {
      log.header('Checking disk free space.');
      disk.getFreeSpace(function(err, freeMbs) {
        freeMbs = Math.round(freeMbs);
        var enoughFreeSpace = freeMbs > INSTALL_MB;
        log.info(freeMbs + ' MB free of the required ' + INSTALL_MB + ' MB');
        if (!enoughFreeSpace) {
          log.fail('Not enough disk space for install!');
        }
        newline();
        next(null);
      });
    },

    // Check if DNS file is already set.
    function(next) {
      log.header('Checking if DNS is set.');
      dnsIsSet = fs.existsSync(KALABOX_DNS_FILE);
      var msg = dnsIsSet ? 'is set.' : 'is not set.';
      log.info('DNS ' + msg);
      log.newline();
      next(null);
    },

    // Download dependencies to temp dir.
    function(next) {
      var urls = [];
      if (!providerIsInstalled) {
        urls.unshift(PROVIDER_URL_V1_4_1);
      }
      if (!profileIsSet) {
        urls.unshift(PROVIDER_URL_PROFILE);
      }
      if (urls.length > 0) {
        var dest = disk.getTempDir();
        log.header('Downloading dependencies.');
        urls.forEach(function(url) { log.info(url); });
        download.downloadFiles(urls, dest, function() {
          log.newline();
          next(null);
        });
      } else {
        next(null);
      }
    },

    // Setup profile.
    function(next) {

      if (!profileIsSet) {
        log.header('Setting up Boot2Docker profile.');
        async.series([

          function(next) {
            log.info('Creating config dir');
            fs.mkdir(deps.lookup('config').sysConfRoot, '0777', function() {
              log.ok('OK');
              next(null);
            });
          },

          function(next) {
            var tmp = disk.getTempDir();
            var src = path.join(tmp, path.basename(PROVIDER_URL_PROFILE));
            var dest = path.join(
              deps.lookup('config').sysConfRoot, 'b2d.profile'
            );
            log.info('Setting B2D profile.');
            fs.rename(src, dest, function() {
              log.ok('OK');
              newline();
              next(null);
            });
          }

        ], function(err, results) {
          if (err) {
            throw err;
          }
          next();
        });
      }
      else {
        next(null);
      }
    },

    // Install packages.
    function(next) {
      if (!providerIsInstalled || !dnsIsSet) {
        log.header('Setting things up.');
        log.alert('ADMINISTRATIVE PASSWORD WILL BE REQUIRED!');

        async.series([

          function(next) {
            if (!providerIsInstalled) {
              disk.getMacVolume(function(err, volume) {
                if (err) {
                  throw err;
                }
                var tempDir = disk.getTempDir();
                var pkg = path.join(
                  tempDir, path.basename(PROVIDER_URL_V1_4_1)
                );
                log.info('Installing: ' + pkg);
                adminCmds.unshift(cmd.buildInstallCmd(pkg, volume));
                next(null);
              });
            }
            else {
              next(null);
            }
          },

          function(next) {
            if (!dnsIsSet) {
              log.info('Setting up DNS for Kalabox.');
              provider.getServerIps(function(ips) {
                var ipCmds = cmd.buildDnsCmd(
                  ips, KALABOX_DNS_PATH, KALABOX_DNS_FILE
                );
                adminCmds = adminCmds.concat(ipCmds);
                next(null);
              });
            }
            else {
              next(null);
            }
          },

          function(next) {
            if (!_.isEmpty(adminCmds)) {
              var child = cmd.runCmdsAsync(adminCmds);
              child.stdout.on('data', function(data) {
                log.info(data);
              });
              child.stdout.on('end', function() {
                log.info('Finished installing');
                log.newline();
                next();
              });
              child.stderr.on('data', function(data) {
                log.warn(data);
              });
            }
            else {
              next(null);
            }
          }

        ], function(err, results) {
            if (err) {
              throw err;
            }
            next();
          });

      }
      else {
        next(null);
      }
    },

    // Init and start boot2docker
    function(next) {
      log.header('Setting up and turning on the Kalabox VM.');
      async.series([

        function(next) {
          // @todo: stop gap for #190 for now. eventually we will have a more
          // robust installer API for providers to add checks and prepares to
          // the installer.
          provider.prepareInstall(function() {
            provider.up(function(err, output) {
              log.info(output);
              next(null);
            });
          });
        }

      ], function(err) {
        if (err) {
          throw err;
        }
        next();
      });
    },

    function(next) {
      log.header('Installing core services.');
      services.install(function() {
        log.info('Core services installed.');
        next(null);
      });
    },

    // Init and start boot2docker
    function(next) {
      log.header('Finishing up.');
      log.ok('Installation complete!');
    }

  ]);

  done();

};
