var couchdb = require('../couchdb'),
    logger = require('../logger'),
    utils = require('../utils'),
    argParse = require('../args').parse,
    async = require('../../deps/async'),
    csv = require('../../deps/node-csv-parser/lib/csv'),
    json = require('../data-stream'),
    events = require('events'),
    util = require('util'),
    url = require('url'),
    fs = require('fs');


exports.summary = 'Performs tranformations on JSON files';
exports.usage = '' +
'kanso transform TRANSFORMATION [OPTIONS] SOURCE TARGET\n' +
'\n' +
'Parameters:\n' +
'  TRANFORMATION    The operation to perform on SOURCE\n' +
'  SOURCE           The source file to use as input\n' +
'  TARGET           The filename for saving the output to\n' +
'\n' +
'Tranformations:\n' +
'  clear-ids    Clear the _id property of each document in the SOURCE file\n' +
'  add-ids      Fetch UUIDs from a CouchDB instance and use as _ids for\n' +
'               each doc in the SOURCE file.\n' +
'  csv          Convert a .csv file to JSON. Each row is converted to a\n' +
'               JSON object, using the values from the first row as\n' +
'               property names.\n' +
'\n' +
'Options:\n' +
'  -i, --indent    The number of spaces to use for indentation, by default\n' +
'                  output is not indented. Use --indent=tabs to use tabs.\n' +
'  -u, --url       The CouchDB instance to fetch UUIDs from. Defaults to\n' +
'                  http://localhost:5984';


function IDStream(db, cacheNum) {
    var that = this;
    this.cache = [];
    this.fetching = false;
    this.on('fetching', function (cacheNum) {
        if (!this.fetching) {
            db.uuids(cacheNum, function (err, uuids) {
                if (err) {
                    that.emit('error', err);
                }
                else {
                    that.fetching = false;
                    that.cache = uuids;
                    that.emit('new_ids', that.cache);
                }
            });
        }
        this.fetching = true;
    });
    this.once('new_ids', function () {
        that.emit('ready');
    });
    this.readID = function (callback) {
        if (!this.cache.length) {
            throw new Error('No IDs ready');
        }
        else {
            if (this.cache.length === 1) {
                this.once('new_ids', function () {
                    that.readID(callback);
                });
                if (!this.fetching) {
                    this.emit('fetching', cacheNum);
                }
            }
            else {
                callback(this.cache.shift());
            }
        }
    };
    that.setMaxListeners(cacheNum - 1);
    process.nextTick(function () {
        that.emit('fetching', cacheNum);
    });
};
util.inherits(IDStream, events.EventEmitter);

exports.createIDStream = function (db, cache) {
    return new IDStream(db, cache);
};


exports.run = function (args) {
    var a = argParse(args, {
        'indent': {match: ['--indent','-i'], value: true},
        'url': {match: ['--url','-u'], value: true}
    });
    var couchdb_url = a.options.url || 'http://localhost:5984';
    var indent = a.options.indent;
    if (indent !== 'tabs' && indent !== undefined) {
        indent = parseInt(indent, 10);
        if (isNaN(indent)) {
            logger.error('--indent option must be a number or "tabs"');
            return;
        }
    }
    var ilead = '';
    if (indent === 'tabs') {
        ilead = '\t';
    }
    else if (indent) {
        for (var i = 0; i < indent; i++) {
            ilead += ' ';
        }
    }
    a.options.ilead = ilead;

    // /_uuids is at the root couchdb instance level, not the db level
    var parsed = url.parse(couchdb_url);
    delete parsed.pathname;
    delete parsed.query;
    delete parsed.search;
    var couchdb_root_url = url.format(parsed);
    var db = couchdb(couchdb_root_url);

    a.options.couchdb_root_url = couchdb_root_url;

    var trans = a.positional[0];

    var source = a.positional[1];
    var target = a.positional[2];
    if (!source) {
        logger.error('No SOURCE file');
        logger.info('Usage: ' + exports.usage);
        return;
    }
    if (!target) {
        logger.error('No TARGET file');
        logger.info('Usage: ' + exports.usage);
        return;
    }

    if (trans === 'clear-ids') {
        exports.clearIDs(db, source, target, a.options);
    }
    else if (trans === 'add-ids') {
        exports.addIDs(db, source, target, a.options);
    }
    else if (trans === 'csv') {
        exports.csv(db, source, target, a.options);
    }
    else {
        if (trans){
            logger.error('Unknown transformation: ' + trans);
        }
        else {
            logger.error('No transformation specified');
        }
        logger.info('Usage: ' + exports.usage);
        return;
    }
};


exports.clearIDs = function (db, source, target, options) {
    var i = 0;
    var doctype = null;
    var p = json.createParseStream();
    var rstream = fs.createReadStream(source);
    rstream.pause();

    var outfile = fs.createWriteStream(target);
    outfile.on('error', function (err) {
        logger.error(err);
    });
    outfile.on('open', function (fd) {
        outfile.on('drain', function () {
            rstream.resume();
        });
        p.on('type', function (type) {
            doctype = type;
            if (doctype === 'array') {
                outfile.write('[');
            }
        });
        p.on('doc', function (doc) {
            delete doc._id;
            var output = JSON.stringify(doc, null, options.ilead);
            if (doctype === 'array') {
                // prepent indent (because its in an array)
                output = options.ilead +
                         output.split('\n').join('\n' + options.ilead);
                // prepend end of previous doc
                output = (i > 0 ? ',\n': '\n') + output;
            }
            var flushed = outfile.write(output);
            if (!flushed) {
                rstream.pause();
            }
            i++;
            if (i % 100 === 0 && i != 0) {
                console.log('Transformed ' + i + ' docs');
            }
        });
        p.on('error', function (err) {
            logger.error(err);
        });
        p.on('end', function () {
            if (i % 100 !== 0) {
                console.log('Transformed ' + i + ' docs');
            }
            if (doctype === 'array') {
                outfile.write('\n]\n');
            }
            logger.end('Saved ' + i + ' docs to ' + target);
        });
        rstream.pipe(p);
        rstream.resume();
    });
};


exports.addIDs = function (db, source, target, options) {
    var i = 0;
    var doctype = null;
    var p = json.createParseStream();
    var rstream = fs.createReadStream(source);
    rstream.pause();

    var idstream = exports.createIDStream(db, 1000);
    idstream.on('error', function (err) {
        logger.error(err);
    });
    idstream.on('new_ids', function () {
        //rstream.resume();
    });
    idstream.on('fetching', function (cacheNum) {
        var dburl = url.format(db.instance);
        logger.info('Fetching ' + cacheNum + ' UUIDs from ' + dburl);
        //rstream.pause();
    });
    idstream.on('ready', function () {
        var outfile = fs.createWriteStream(target);
        outfile.on('error', function (err) {
            logger.error(err);
        });
        outfile.on('open', function (fd) {
            outfile.on('drain', function () {
                rstream.resume();
            });
            p.on('type', function (type) {
                doctype = type;
                if (doctype === 'array') {
                    outfile.write('[');
                }
            });
            p.on('doc', function (doc) {
                rstream.pause();
                idstream.readID(function (uuid) {
                    doc._id = uuid;
                    var output = JSON.stringify(doc, null, options.ilead);
                    if (doctype === 'array') {
                        // prepent indent (because its in an array)
                        output = options.ilead +
                                 output.split('\n').join('\n' + options.ilead);
                        // prepend end of previous doc
                        output = (i > 0 ? ',\n': '\n') + output;
                    }
                    var flushed = outfile.write(output);
                    if (!flushed) {
                        rstream.pause();
                    }
                    else {
                        rstream.resume();
                    }
                    i++;
                    if (i % 100 === 0 && i != 0) {
                        console.log('Transformed ' + i + ' docs');
                    }
                });
            });
            p.on('error', function (err) {
                logger.error(err);
            });
            p.on('end', function () {
                if (i % 100 !== 0) {
                    console.log('Transformed ' + i + ' docs');
                }
                if (doctype === 'array') {
                    outfile.write('\n]\n');
                }
                logger.end('Saved ' + i + ' docs to ' + target);
            });
            rstream.pipe(p);
            rstream.resume();
        });
    });
};


exports.csv = function (db, source, target, options) {
    var headings = null;
    var results = [];

    var outfile = fs.createWriteStream(target);
    outfile.on('error', function (err) {
        logger.error(err);
    });
    outfile.on('open', function (fd) {
        outfile.write('[');
        var csvfile = csv().fromPath(source);
        outfile.on('drain', function () {
            csvfile.readStream.resume();
        });
        csvfile.on('data', function(data, index){
            if (index === 0) {
                headings = data;
            }
            else {
                var obj = {};
                for (var i = 0, len = data.length; i < len; i++) {
                    if (headings[i] && data[i] !== '') {
                        obj[headings[i]] = data[i];
                    }
                }
                var output = JSON.stringify(obj, null, options.ilead);
                // prepent indent (because its in an array)
                output = options.ilead +
                         output.split('\n').join('\n' + options.ilead);
                var flushed = outfile.write(
                    (index > 1 ? ',\n': '\n') + output
                );
                if (!flushed) {
                    csvfile.readStream.pause();
                }
            }
            if (index % 100 === 0 && index != 0) {
                console.log('Transformed ' + index + ' rows');
            }
        });
        csvfile.on('end', function(count){
            if ((count-1) % 100 !== 0) {
                console.log('Transformed ' + (count - 1) + ' rows');
            }
            outfile.on('close', function () {
                logger.end('Saved ' + (count - 1) + ' entries to ' + target);
            });
            outfile.write('\n]\n');
            outfile.end();
        });
        csvfile.on('error', function(error){
            logger.error(error.message);
        });
    });
};