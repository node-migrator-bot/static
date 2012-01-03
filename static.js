//TODO: readdir should read target, not source
//TODO: connect middleware for styles and scripts

var fs = require('fs'),
  markdown = require('markdown').markdown,
  path = require('path'),
  stylus = require('stylus'),
  handlebars = require('handlebars'),
  express = require('express'),
  _ = require('underscore'),
  wrench = require('wrench'),
  watch = require('watch'),
  io = require('socket.io'),
  jsdom = require('jsdom'),
  os = require('os'),
  exec = require('child_process').exec;

var actions = {
  start: function() {
    var path, port;
    if (arguments.length === 2) {
      path = arguments[0];
      port = arguments[1];
    } else if (arguments.length === 1) {
      if (String(arguments[0]).match(/^[\d]+$/)) {
        port = arguments[0];
      } else {
        path = arguments[0];
      }
    }
    var static = new Static(path || '.');
    static.listen(port || 8000);
  },
  publish: function() {
    var static = new Static(arguments.length < 2 ? '.' : arguments[0]);
    var args = _.toArray(arguments);
    args = args.slice(1);
    static.publish.apply(static, args);
  },
  create: function(target) {
    var command = 'git clone -b bootstrap git://github.com/walmartlabs/static.git ' + target + '; rm -rf ' + path.join(target, '.git');
    console.log(command);
    exec(command, function(error, stdout, stderr) {
      if (stdout) {
        console.log(stdout);
      }
      if (stderr) {
        console.log(stderr);
      }
      console.log('new static project created in ' + target);
    });
  }
};

//for handlebars helpers
var currentFile = false;

var Static = function(working_path) {
  this.path = working_path;
  try {
    this.package = JSON.parse(fs.readFileSync(path.join(this.path, 'package.json')));
  } catch (e) {
    console.log(e);
    this.package = {};
  }
  this.hostname = os.hostname();
  this.files = {};
  this.setMaxListeners(100);
};

Static.action = function(name) {
  return actions[name].apply(this, _.toArray(arguments).slice(1));
};

Static.prototype = new process.EventEmitter();
_.extend(Static.prototype, {
  registerTransform: function(name, callback) {
    transforms[name] = callback;
  },
  readdir: function(dirname) {
    return _.compact(fs.readdirSync(path.join(this.path, dirname)).map(function(filename) {
      if (!filename.match(/^\./)) {
        //TODO: remove stylus and coffee references
        return path.join(path, filename.replace(/\.styl$/, '.css').replace(/\.coffee$/, '.js'));
      }
    }));
  },
  file: function(pattern, callback) {
    var iterator = _.bind(function(file) {
      var fragment = file.source.substring(this.path.length - 1);
      if (typeof pattern === 'string') {
        pattern = pattern.replace(/^\//, '');
      }
      if ((typeof pattern === 'string' && fragment === pattern) || fragment.match(pattern)) {
        callback.call(this, file);
      }
    }, this);
    for (var filename in this.files) {
      iterator(this.files[filename]);
    }
    this.on('file', iterator);
  },
  createFile: function(filename) {
    this.files[filename] = new File(this, filename);
    this.emit('file', this.files[filename]);
    return this.files[filename];
  },
  loadPlugins: function() {
    builtInPlugin.call(this, this);
    var plugins_dir = path.join(process.cwd(), this.path, 'plugins');
    fs.readdirSync(plugins_dir).forEach(function(plugin_path) {
      var plugin = require(path.join(plugins_dir, plugin_path));
      plugin(this);
    }, this);
  },
  watch: function(callback) {
    this.loadPlugins();
    watch.watchTree(this.path, _.bind(function (filename, curr, prev) {
      if (typeof filename == "object" && prev === null && curr === null) {
        for (var f in filename) {
          if (!isDotFile.call(this, f)) {
            if (f != this.path) {
              var stats = fs.statSync(f);
              if (!stats.isDirectory()) {
                this.createFile(f).update();
              }
            }
          }
        }
      } else if (!isDotFile.call(this, filename)) {
        try {
          var stats = fs.statSync(filename);
        } catch(e) {
          if (this.files[filename]) {
            this.files[filename].destroy();
          }
        } finally {
          if (stats) {
            if (prev === null && !stats.isDirectory()) {
              this.createFile(filename).update();
            } else if (curr.nlink === 0 && this.files[filename]) {
              this.files[filename].destroy();
            } else if (!stats.isDirectory() && this.files[filename]) {
              this.files[filename].update();
            }
          }
        }
      }
    }, this));
  },
  publish: function(target) {
    publishToPath.call(this, target);
    this.watch();
  },
  listen: function(port) {
    var tmp_path = '/tmp/static-listen-' + process.pid;
    publishToPath.call(this, tmp_path);
    process.on('SIGINT', function() {
      wrench.rmdirSyncRecursive(tmp_path);
      process.exit();
    });
    this.watch();
    this.server = express.createServer();
    this.server.use(express.static(tmp_path));
    this.server.listen(port);
    broadcastUpdates.call(this);
    console.log('static + express listening on port ' + port);
  },
  helper: function(name, callback) {
    handlebars.registerHelper(name, _.bind(function() {
      var output = callback.apply(this, [currentFile].concat(_.toArray(arguments)));
      return new handlebars.SafeString(output || '');
    }, this));
  }
});

function isDotFile(filename) {
  //is a dotfile or inside a dot directory
  return path.basename(filename).match(/^\./) || filename.substring(this.path.length - 1).match(/^\./);
}

function broadcastUpdates() {
  var listener = io.listen(this.server);
  listener.set('log level', 1);
  function payloadFromFile(file) {
    if (!file._writeTargets.length) {
      return false;
    } else {
      return {
        urls: file._writeTargets.map(function(write_target) {
          return path.join(write_target, file.name);
        })
      };
    }
  }
  this.on('write', function(file) {
    var payload = payloadFromFile(file);
    if (payload) {
      listener.sockets.emit('reload', payload);
    }
  });
  this.on('destroy', function(file) {
    var payload = payloadFromFile(file);
    if (payload) {
      listener.sockets.emit('destroy', payload);
    }
  });
}

function publishToPath(target_path) {
  this.on('write', _.bind(function(file, next) {
    file._writeTargets.forEach(function(write_target) {
      var source = path.join(this.path, file.source.substring(this.path.length - 1))
      var target = path.join(target_path, write_target, file.name);
      wrench.mkdirSyncRecursive(path.dirname(target));
      fs.writeFile(target, file.buffer);
      console.log('Static wrote: ' + target);
    }, this);
    next();
  }, this));
  this.on('destroy', function(file) {
    file._writeTargets.forEach(function(write_target) {
      var target = path.join(target_path, write_target, file.name);
      fs.unlink(target);
      console.log('Static removed: ' + target);
    });
  });
}

var File = function(static, source) {
  this.static = static;
  this.source = source;
  this._scope = {};
  this.name = path.basename(this.source);
  this._writeTargets = [];
  this._dependencies = [];
  this.setMaxListeners(100);
};
File.prototype = new process.EventEmitter();
_.extend(File.prototype, {
  update: function() {
    var file = this;
    fs.readFile(this.source, function(err, buffer) {
      file.buffer = buffer;
      var loop = function(object, event_name, complete) {
        var listeners = _.toArray(object.listeners(event_name));
        var step = function() {
          if (listeners.length) {
            var listener = listeners.shift();
            listener(file, step);
          } else {
            if (complete) {
              complete();
            }
          }
        };
        step();
      };
      loop(file, 'read', function() {
        loop(file.static, 'read', function() {
          loop(file, 'write', function() {
            loop(file.static, 'write');
          });
        });
      });
    });
  },
  destroy: function() {
    this.emit('destroy');
    this.static.emit('destroy', this);
    delete this.static.files[this.source];
  },
  write: function(target) {
    this._writeTargets.push(target);
  },
  set: function(key, value) {
    return this._scope[key] = value;
  },
  get: function(key) {
    return this._scope[key];
  },
  unset: function(key) {
    delete this._scope[key];
  },
  transform: function(name, callback) {
    this.on('read', function(file, next) {
      transforms[name].call(file, file.buffer, function(buffer) {
        file.buffer = buffer;
        next();
      }, callback);
    });
  },
  changeExtensionTo: function(extension) {
    this.name = this.name.replace(/\.[a-zA-Z]+$/, '.' + extension);
  },
  $: function(callback) {
    this.on('write', function(file, next) {
      var jquery_path = path.join(__dirname, 'jquery.js');
      try {
        jsdom.env(file.buffer.toString(), [
          jquery_path
        ], function(errors, window) {
          if (errors) {
            console.log(errors);
            next();
          } else {
            callback(window);
            window.$('script[src="' + jquery_path + '"]').remove();
            file.buffer = '<!DOCTYPE html>' + window.document.documentElement.outerHTML;
            next();
          }
        });
      } catch(e) {
        console.log(e);
        next();
      }
    });
  },
  addDependency: function(filename) {
    //TODO: fix stylus hack
    filename = filename.replace(/\.css$/, '.styl');
    if (this._dependencies.indexOf(filename) === -1) {
      this._dependencies.push(filename);
      this.static.file(filename, _.bind(function(file) {
        file.on('write', _.bind(function(file, next) {
          this.update();
          next();
        }, this));
      }, this));
    }
  },
  include: function(filename, options) {
    filename = guessFilename(path.join(this.static.path, filename));
    if (!filename) {
      throw new Error(filename + ' does not exist');
    }
    this.addDependency(filename.substring(this.static.path.length - 1));
    var buffer = fs.readFileSync(filename);
    if (filename.match(/\.(md|markdown)$/)) {
      return markdown.toHTML(buffer.toString());
    } else if (filename.match(/\.handlebars$/)) {
      try {
        var template = handlebars.compile(fs.readFileSync(filename).toString());
        return template(_.extend({}, this._scope, options || {}));
      } catch (e) {
        console.log(e);
        return '';
      }
    } else {
      return buffer;
    }
  },
  renderString: function(contents, options) {
    try {
      var template = handlebars.compile(contents);
      return template(_.extend({}, this._scope, options || {}));
    } catch(e) {
      console.log(e);
      return '';
    }
  }
});

function guessFilename(name) {
  return _.find([
    name,
    name + '.md',
    name + '.markdown',
    name + '.html',
    name + '.handlebars',
    name + '.css',
    name + '.styl',
    name + '.coffee',
    name + '.js'
  ], function(guess) {
    return path.existsSync(guess);
  });
}

var transforms = {
  markdown: function(buffer, next, callback) {
    if (callback) {
      callback(buffer, markdown);
    }
    next(markdown.toHTML(buffer.toString()));
  },
  handlebars: function(buffer, next, callback) {
    currentFile = this;
    if (callback) {
      callback(buffer, handlebars);
    }
    try {
      var template = handlebars.compile(buffer.toString());
      next(template(this._scope));
    } catch(e) {
      console.log(e);
      next('');
    }
  },
  stylus: function(buffer, next, callback) {
    var compiler = stylus(buffer.toString());
    if (callback) {
      callback(buffer, compiler);
    }
    compiler.render(function(error, buffer) {
      if (error) {
        console.log('Stylus error: ' + error.name);
        console.log(error.message);
      }
      next(buffer || '');
    });
  }
};

function builtInPlugin(static) {
  
  //add {{set key="value"}} helper
  static.helper('set', function(file, options) {
    for (var key in options.hash) {
      file.set(key, options.hash[key]);
    }
  });
  
  //live update helper
  static.helper('live-reload', function(file) {
    if (!static.server) {
      return '';
    } else {
      return [
        '<script src="/socket.io/socket.io.js"></script>',
        "<script>",
        "  function shouldExecute(data) {",
        "    var path = window.location.pathname.substring(1).replace(/index(\\.[a-z]+)?$/, '');",
        "    return data.urls.map(function(url){",
        "      return url.replace(/index(\\.[a-z]+)?$/, '');",
        "    }).indexOf(path) !== -1;",
        "  }",
        "  var socket = io.connect('http://" + static.hostname + "');",
        "  socket.on('reload', function(data) {",
        "    if (shouldExecute(data)) {",
        "      window.location.reload();",
        "    }",
        "  });",
        "  socket.on('destroy', function(data) {",
        "    if (shouldExecute(data)) {",
        "      alert('This page has been removed from the server.');",
        "    }",
        "  });",
        "</script>"
      ].join("\n");
    }
  });
  
  //add {{include path}} helper
  static.helper('include', function(file, include_path, options) {
    return file.include(path.join('includes', file.renderString(include_path)), options ? options.hash : {});
  });
  
  function attributesFromOptions(options) {
    if (!options) {
      return '';
    }
    var output = [];
    for (var option_name in options.hash) {
      output.push(option_name + '="' + options.hash[option_name] + '"');
    }
    return output.join(' ');
  }

  //add {{script src}} and {{scripts}} helpers
  function script(file, src, options) {
    src = path.join('scripts', file.renderString(src));
    file.addDependency(src);
    return '<script type="text/javascript" src="' + src + '"' + attributesFromOptions(options) + '></script>';
  };
  static.helper('scripts', function(file, options) {
    return (file.scripts || []).map(function(src) {
      return script(file, src, options);
    }).join("\n");
  });
  static.helper('script', script);
  
  //add {{style href}} and {{styles}} helpers
  function style(file, href, options) {
    href = path.join('styles', file.renderString(href));
    file.addDependency(href);
    return '<link rel="stylesheet" href="' + href + '"' + attributesFromOptions(options) + '/>';
  };
  static.helper('styles', function(file, options) {
    return (file.styles || []).map(function(href) {
      return style(file, href, options);
    }).join("\n");
  });
  static.helper('style', style);
}

module.exports = Static;