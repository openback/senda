'use strict';

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');
var util = require('util');

var AWS = require('aws-sdk');
// TODO: Use the config

AWS.config.update({region: process.env.AWS_DEFAULT_REGION || 'us-east-1'});

if (process.env.AWS_PROFILE) {
    var credentials = new AWS.SharedIniFileCredentials({profile: process.env.AWS_PROFILE});
    AWS.config.credentials = credentials;
}

var archiver = require('archiver');
var async = require('async');
var awsLambda = require("node-aws-lambda");
var del = require('delete');
var vfs = require('vinyl-fs');
var lambda = new AWS.Lambda();
var which = require('which');
var _ = require('lodash');

function populateConfig(lambdaPath, callback) {
    // Grab the top-level config
    var projectConfig = {
        handler: 'index.handler',
        contextName: '',
        memorySize: 128,
        region: 'us-east-1',
        role: '',
        runtime: 'nodejs',
        timeout: 10,
        naming: 'camel'
    };

    try {
        projectConfig = require(path.join(process.cwd(), 'lambda-config.js'));
    } catch(e) {
        console.log('NOTICE: No project-level lambda-config.js found. Skipping.');
    }

    if (!fs.existsSync(lambdaPath)){
        return callback('ERROR: Lambda folder not found: %s' + lambdaPath);
    }

    var localConfigPath = path.join(lambdaPath, 'lambda-config.js');
    var lambdaConfig = projectConfig;

    if (fs.existsSync(localConfigPath)) {
        lambdaConfig = _.merge({}, projectConfig, require(localConfigPath));
    }

    if (!lambdaConfig.functionName) {
        lambdaConfig.functionName = path.basename(lambdaPath);
    }

    switch (projectConfig.naming) {
        case 'camel':
            lambdaConfig.functionName = util.format('%s%s%s',
                lambdaConfig.contextName,
                lambdaConfig.functionName.charAt(0).toUpperCase(),
                lambdaConfig.functionName.slice(1));
            break;
        case 'snake':
            lambdaConfig.functionName = util.format('%s_%s',
                lambdaConfig.contextName,
                lambdaConfig.functionName.toLowerCase());
            break;
        case null:
        case undefined:
            return callback('Naming scheme not set');
        default:
            return callback('Unknown naming scheme: %s', projectConfig.naming);
    }

    // Make all include paths absolute
    // TODO: Ensure these merge properly
    if (lambdaConfig.include) {
        for(var i = 0; i < lambdaConfig.include.length; i++) {
            var contextPath = path.dirname(lambdaPath);

            lambdaConfig.include[i] = path.resolve(contextPath, lambdaConfig.include[i]);
        }
    }

    //console.log(lambdaConfig);
    callback(null, lambdaConfig);
}

function buildNodeModules(lambdaName, callback) {
    var lambdaPath = path.join(process.cwd(), lambdaName);
    var pkgJSONPath = path.join(lambdaPath, 'package.json');

    console.log('Checking for: "$s"', pkgJSONPath);

    if (!fs.existsSync(pkgJSONPath)) {
        console.log('Not found: "$s"', pkgJSONPath);
        return callback();
    }

    var pkgJSON = require(pkgJSONPath);

    console.log('Original package.json: %j', pkgJSON);

    if (!pkgJSON.dependencies) {
        return callback();
    }

    var contextPath = path.dirname(lambdaPath);
    var modules = Object.getOwnPropertyNames(pkgJSON.dependencies);

    if (!modules || !modules.length) {
        // No dependencies, so we don't even care about the file anymore
        return callback();
    }

    async.each(modules,
        function(moduleName, done) {
            var dependency = pkgJSON.dependencies[moduleName];

            if (dependency.indexOf('file:') === 0) {
                var dependencyPath = dependency.substring(5);
                var modulePath = path.resolve(lambdaPath, dependencyPath);
                pkgJSON.dependencies[moduleName] = 'file:' + modulePath;
            }

            done();
        }, function(err) {
            if (err) {
                return callback(err);
            }

            console.log('Processed package.json: %j', pkgJSON);

            var buildPath = path.join(lambdaPath, 'build');
            var buildPkgJSONPath = path.join(buildPath, 'package.json');
            console.log('Writing new package.json at "%s"', buildPkgJSONPath);

            fs.writeFile(buildPkgJSONPath, JSON.stringify(pkgJSON, null, 2),
                function(err) {
                    if (err) {
                        return callback(util.format('Could not create $s', buildPkgJSONPath));
                    }

                    console.log('Installing npm modules...');

                    run({
                        cmd: 'npm',
                        args: ['install', '--progress=false'],
                        cwd: buildPath
                    }, callback);
                }
            );
        }
    );
}

function build(lambdaNames, callback) {
    async.each(lambdaNames, function(lambdaName, done) {
        var lambdaPath = path.join(process.cwd(), lambdaName);

        populateConfig(lambdaPath, function(err, lambdaConfig) {
            if (err) {
                console.error('ERROR: %s', err);
                return done();
            }

            var buildPath = path.join(lambdaPath, 'build');
            console.log('Building %s in %s', lambdaName, buildPath);

            if (!fs.existsSync(buildPath)) {
                fs.mkdirSync(buildPath);
            }

            var files = [];

            if (lambdaConfig.runtime === 'nodejs') {
                files.push(path.join(lambdaPath, '*.js'));
                files.push(path.join(lambdaPath, 'package.json'));

                if (lambdaConfig.include && lambdaConfig.include.length) {
                    Array.prototype.push.apply(files, lambdaConfig.include);
                }
            } else if (lambdaConfig.runtime === 'python2.7') {
            } else {
                return done(util.format('Unkown runtime for "%s": "%s"', lambdaName,
                    lambdaConfig.runtime));
            }

            vfs.src(files).pipe(vfs.dest(buildPath)).on('end', function(err) {
                if (err) {
                    return callback(err);
                }

                // Now for libraries
                if (lambdaConfig.runtime === 'nodejs') {
                    buildNodeModules(lambdaName, done);
                } else if (lambdaConfig.runtime === 'python2.7') {
                    done();
                }
            });
        });
    }, callback);
}

function run (command, callback) {
    which(command.cmd, function(err, cmdpath){
        if (err) {
            callback(new Error('Can\'t install! `' + command.cmd + '` doesn\'t seem to be installed.'));
            return;
        }
        var cmd = childProcess.spawn(cmdpath, command.args, {stdio: 'inherit', cwd: command.cwd || process.cwd()});
        cmd.on('close', function (code) {
            if (code !== 0) {
                return callback(new Error(command.cmd + ' exited with non-zero code ' + code));
            }
            callback();
        });
    });
}

function clean(lambdaNames, callback) {
    async.each(lambdaNames, function(lambdaName, done) {
        var lambdaPath = path.join(process.cwd(), lambdaName);
        var buildPath = path.join(lambdaPath, 'build');

        del([path.join(lambdaPath, 'build.zip'), buildPath], done);
    }, callback);
}

function upload(lambdaNames, callback) {
    async.each(lambdaNames, function(lambdaName, done) {
        var lambdaPath = path.join(process.cwd(), lambdaName);

        populateConfig(lambdaPath, function(err, lambdaConfig) {
            var buildPkg = path.join(lambdaPath, 'build.zip');

            if (!fs.existsSync(buildPkg)) {
                done(util.format('Could not find "%s"', buildPkg));
                return;
            }

            console.log('Uploading %s from %s', lambdaName, buildPkg);

            awsLambda.deploy(buildPkg, lambdaConfig, function(err, data) {
                if (!err) {
                    console.log('%s deployed', lambdaName);
                }

                console.log(err);

                done(err);
                // TODO: Get awsLambda.deploy to returnthe lambda info
                // so we can attach aliases
            });
        });
    }, callback);
}

function invoke(lambdaNames, callback) {
    async.each(lambdaNames, function(lambdaName, done) {
        var lambdaPath = path.join(process.cwd(), lambdaName);

        populateConfig(lambdaPath, function(err, lambdaConfig) {
            if (err) {
                return done(err);
            }

            var eventPath = path.join(lambdaPath, 'event.js');

            if (!fs.existsSync(eventPath)) {
                return done(util.format('event.js not found in %s', lambdaPath));
            }

            lambda.invoke({
                FunctionName: lambdaConfig.functionName,
                InvocationType: 'RequestResponse',
                LogType: 'Tail',
                Payload: JSON.stringify(require(eventPath))

            }, function(err, data) {
                if (err) {
                    return (done(err));
                    // console.log(err, err.stack);
                }

                var payload = JSON.parse(data.Payload);
                var log = new Buffer(data.LogResult, 'base64').toString("ascii");

                console.log(payload);
                console.log('--------------------------------------------------');
                console.log(log);
            });
        });
    }, callback);
}

function zip(lambdaNames, callback) {
    async.each(lambdaNames, function(lambdaName, done) {
        var lambdaPath = path.join(process.cwd(), lambdaName);
        var buildPath = path.join(lambdaPath, 'build');
        var pkgPath = path.join(lambdaPath, 'build.zip');
        var zip = archiver.create('zip', {});

        console.log('Building: %s in %s', lambdaName, pkgPath);

        var output = fs.createWriteStream(pkgPath);

        output.on('close', function() {
          console.log('Wrote %sb to %s', zip.pointer(), pkgPath);
        });

        zip.on('error', done);
        zip.pipe(output);
        zip.directory(buildPath, '/').finalize();
    }, callback);
}

module.exports = {
    build: build,
    clean: clean,
    invoke: invoke,
    populateConfig: populateConfig,
    upload: upload,
    zip: zip
};
