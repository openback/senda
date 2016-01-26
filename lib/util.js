'use strict';

var fs = require('fs');
var path = require('path');
var util = require('util');

var AWS = require('aws-sdk');
// TODO: Use the config
AWS.config.update({region: 'us-east-1'});
var archiver = require('archiver');
var async = require('async');
var awsLambda = require("node-aws-lambda");
var del = require('delete');
var vfs = require('vinyl-fs');
var lambda = new AWS.Lambda();
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
        timeout: 10
    };

    /***
     BEGIN
     ***/
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

    lambdaConfig.functionName = util.format('%s%s%s',
        lambdaConfig.contextName,
        lambdaConfig.functionName.charAt(0).toUpperCase(),
        lambdaConfig.functionName.slice(1));

    // Make all include paths absolute
    // TODO: Ensure these merge properly
    if (lambdaConfig.include) {
        for(var i = 0; i < lambdaConfig.include.length; i++) {
            var contextPath = path.dirname(lambdaPath);

            lambdaConfig.include[i] = path.resolve(contextPath, lambdaConfig.include[i]);
        }
    }

    callback(null, lambdaConfig);
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

            var files = [path.join(lambdaPath, '*.js')];

            if (lambdaConfig.include && lambdaConfig.include.length) {
                Array.prototype.push.apply(files, lambdaConfig.include);
            }

            vfs.src(files).pipe(vfs.dest(buildPath));

            done();
        });
    }, callback);
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
