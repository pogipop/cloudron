#!/usr/bin/env node

'use strict';

require('supererror')({ splatchError: true });

var tar = require('tar-fs');

var sourceDir = process.argv[2];

if (sourceDir === '--check') return console.log('OK');

process.stderr.write('Packing ' + sourceDir + '\n');

tar.pack('/', {
    dereference: false, // pack the symlink and not what it points to
    entries: [ sourceDir ],
    map: function(header) {
        header.name = header.name.replace(new RegExp('^' + sourceDir + '(/?)'), '.$1'); // make paths relative
        return header;
    },
    strict: false // do not error for unknown types (skip fifo, char/block devices)
}).pipe(process.stdout);
