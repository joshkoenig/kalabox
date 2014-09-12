var _ = require('lodash');
var fs = require('fs');
var path = require('path');
var baseDir = path.resolve('./');
var config = require('../config.json');
var Docker = require('dockerode');
var docker =  new Docker(config.docker);

console.log(config);

var Q = require('q');


var App = function(appName) {
  var appdir = path.resolve(config.appDir);
  this.appPath = path.resolve(appdir, appName);
  this.appName = appName;
  this.cidPath = path.resolve(this.appPath, 'cids');
  this.config = require(path.resolve(this.appPath, 'config.json'));
  this.prefix = this.config.name + '_';
  this.hasData = this.config.components.hasOwnProperty('data');
  this.dataCname = this.hasData ? this.prefix + 'data' : null;
  var self = this;
  // Set more properties for each component
  _.map(this.config.components, function(obj, key) {
    obj.key = key;
    obj.dataCname = self.hasData && key !== 'data' ? self.dataCname : null;
    obj.cname = self.prefix + key;
    obj.cidfile = path.resolve(self.cidPath, key);
    if (fs.existsSync(obj.cidfile)) {
      obj.cid = fs.readFileSync(obj.cidfile);
    }
    if (obj.build) {
      obj.src = path.resolve(obj.src);
    }
  });
};

var checkCreateContainer = function(obj) {
  if (fs.existsSync(obj.cidfile)) {
    // if the file exists, verify the container exists
    var container = docker.getContainer(fs.readFileSync(obj.cidfile));
    container.inspect(function(err, data) {
      // remove the file if the container doesn't exist
      if (err) {
        fs.unlinkSync(obj.cidfile);
        createContainer(obj, obj.key);
      }
    });
  }
  else {
    createContainer(obj, obj.key);
  }
};

var createContainer = function(obj) {
  docker.createContainer({
    Hostname: obj.cname,
    name: obj.cname,
    Image: obj.image,
    Dns: ['8.8.8.8', '8.8.4.4'],
    cidfile: obj.cidfile
  }, function(err, container) {
    if (container) {
      var fs = require('fs');
      fs.writeFileSync(path.resolve(obj.cidfile), container.id);
      container.start({PublishAllPorts: true, VolumesFrom: obj.dataCname}, function(err, data) {
      });
    }
  });
};

var startContainer = function(obj) {
  docker.getContainer(obj.cid).start({PublishAllPorts: true, VolumesFrom: obj.dataCname}, function(err, data) {
  });
};

var stopContainer = function(obj) {console.log(obj);
  docker.getContainer(obj.cid).stop(function(err, data) {
  });
};

var restartContainer = function(obj) {
  docker.getContainer(obj.cid).stop(function(err, data) {
    docker.getContainer(obj.cid).start(function(err, data) {
    });
  });
};

var killContainer = function(obj) {
  docker.getContainer(obj.cid).kill(function(err, data) {
  });
};

var removeContainer = function(obj) {
  docker.getContainer(obj.cid).remove(function(err, data) {
    if (!err && fs.existsSync(obj.cidfile)) {
      fs.unlinkSync(obj.cidfile);
    }
  });
};

var pullImage = function(obj, components, deferred) {
  console.log('pulling ' + obj.image);

  docker.pull(obj.image, function (err, stream) {
    if (err) {
      throw err;
    }

    stream.on('data', function(data) {
      // this is needed?
    });

    stream.on('end', function() {
      obj.pulled = true;
      console.log(obj.image + ' pull complete.');

      if (_.every(components, {'pulled': true})) {
        _(components).each(function(obj) {
          delete obj.pulled;
        });
        deferred.resolve();
      }

    });
  });
};

var buildImage = function(obj, components, deferred) {
  console.log('building ' + obj.image);

  var filename = obj.key + '.tar';
  var file = path.resolve(obj.src, filename);

  try {
    console.log(obj.src);
    process.chdir(obj.src);
  }
  catch (err) {
    throw err;
  }

  var exec = require('child_process').exec;
  exec('tar -cvf ' + file+ ' *', function (err, stdout, stderr) {
    if (err) {
      throw err;
    }

    var data = fs.createReadStream(file);
    docker.buildImage(data, {t: obj.image}, function (err, stream){
      if (err) {
        throw err;
      }

      stream.on('data', function(data) {
        // this is needed?
      });

      stream.on('end', function() {
        fs.unlinkSync(file);
        process.chdir(baseDir);

        obj.built = true;
        console.log(obj.image + ' build complete.');

        if (_.every(components, {'built': true, 'build': true})) {
          _(components).each(function(obj) {
            delete obj.built;
          });
          deferred.resolve();
        }
      });
    });
  });
};

App.prototype.init = function() {
  this.createContainers();
};

App.prototype.createContainers = function() {
  if (this.config.components.data) {
    // Create the data container first so volumes
    // can be mounted to all other containers
    createContainer(this.config.components.data);
    var components = _.cloneDeep(this.config.components);
    delete components.data;
  }

  // Create all other containers
  _.map(components, checkCreateContainer);
};

App.prototype.start = function() {
  // Start all containers
  _.map(this.config.components, startContainer);
};

App.prototype.stop = function() {
  // Stop all containers
  _.map(this.config.components, stopContainer);
};

App.prototype.restart = function() {
  // Restart all containers
  _.map(this.config.components, restartContainer);
};

App.prototype.kill = function() {
  // Kill all containers
  _.map(this.config.components, killContainer);
};

App.prototype.remove = function() {
  // Remove all containers
  _.map(this.config.components, removeContainer);
};

App.prototype.pull = function() {
  var self = this;
  var deferred = Q.defer();

  var pulls = _.filter(self.config.components, function(obj) {
    return obj.build !== true;
  });

  _(pulls).each(function(obj) {
    pullImage(obj, pulls, deferred);
  });

  return deferred.promise;
};

App.prototype.build = function() {
  var self = this;
  var deferred = Q.defer();

  var builds = _.filter(self.config.components, function(obj) {
    return obj.build === true;
  });

  _(builds).each(function(obj) {
    buildImage(obj, builds, deferred);
  });

  return deferred.promise;
};

module.exports = App;