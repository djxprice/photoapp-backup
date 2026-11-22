#!/usr/bin/env node
'use strict';
/*
  Makes lib/timeline-bundle.js (2026-11-22): the timeline rules
  (lib/timeline.js) and the pages' view of them (lib/timeline-view.js) as one
  browser script, for an exported timeline, which has no PC behind it but
  must lay the timeline out exactly as the PC and the phone do.

    node pc/lib/timeline-bundle-make.js        (after changing either file)

  The script is kept as a string in a file of its own because the packaged
  PicJot for Windows (tools/pc-package/bundle.js) has no source files on disk
  to read. pc/test/timeline-export.test.js checks it's current.
*/
const fs = require('fs');
const path = require('path');
const { TAG_FOLDER } = require('./plan');

// Bundled as they are, each in a function with its own require; ./plan, of
// which lib/timeline.js only needs the tag folder's name, as that value.
const FILES = { './timeline': 'timeline.js', './timeline-view': 'timeline-view.js' };

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/\r\n/g, '\n');

// The browser script: defines PicJotTimeline ({ exportedView, pageEntries }).
function browserScript() {
  const defs = [`"./plan": function (exports, require, module) {\nmodule.exports = { TAG_FOLDER: ${JSON.stringify(TAG_FOLDER)} };\n}`];
  for (const [id, file] of Object.entries(FILES)) {
    defs.push(`${JSON.stringify(id)}: function (exports, require, module) {\n${read(file)}\n}`);
  }
  return [
    'var PicJotTimeline = (function () {',
    "'use strict';",
    `var defs = {\n${defs.join(',\n')}\n};`,
    'var cache = {};',
    'function req(id) {',
    '  if (!cache[id]) {',
    '    var module = { exports: {} };',
    '    cache[id] = module;',
    '    defs[id](module.exports, req, module);',
    '  }',
    '  return cache[id].exports;',
    '}',
    "return req('./timeline-view');",
    '})();',
    '',
  ].join('\n');
}

function bundleModule() {
  return [
    "'use strict';",
    '// Made by lib/timeline-bundle-make.js from lib/timeline.js and lib/timeline-view.js:',
    "// don't edit; run `node pc/lib/timeline-bundle-make.js` after changing them.",
    `module.exports = ${JSON.stringify(browserScript())};`,
    '',
  ].join('\n');
}

if (require.main === module) {
  fs.writeFileSync(path.join(__dirname, 'timeline-bundle.js'), bundleModule());
  console.log('Wrote pc/lib/timeline-bundle.js');
}

module.exports = { browserScript, bundleModule };
