/*jshint -W030 */
var esprima = require('esprima'),
    fs = require('fs'),
    jsdoc = require('jsdoc-parse'),
    path = require('path');

var argv;

function fatalError(message, e) {
    console.error('*** ' + message);
    e && console.error(e);
    console.error('Aborting.\n');
    process.exit(1);
}

function defined(x) {
    return x !== undefined;
}

function defaultValue(x, y, z) {
    if (defined(x)) {
        return x;
    } else if (defined(y)) {
        return y;
    } else 
    return z;
}

// returns a custom @tag for a comment, or else the fallback value.
function getTag(item, tag, fallback) {
    try {
        return item.customTags.filter(eq('tag', tag))[0].value;
    } catch (e) {
        return fallback;
    }
}

// 'myWmsPropName' -> 'My WMS prop name'
function titleify(propName) {
    var s = propName[0].toUpperCase();
    for (var i = 1; i < propName.length; i++) {
        if (propName[i].match(/[A-Z]/)) {
            s += ' ' + propName[i].toLowerCase();
        } else {
            s += propName[i];
        }
    }
    return s.split(' ').map(function(word) {
        if (word.match(/^(wms|url|kml|csv|json|id|gpx|czml|csv|wfs|wmts|geojson|ckan)$/i)) {
            return word.toUpperCase();
        } else {
            return word;
        }
    }).join(' ');
}

// return an esprima parse tree from a file.
function parseCode(filename) {
    return esprima.parse(fs.readFileSync(filename, 'utf8'));
}

// allows x.filter(eq('a.b.c', 3))
function eq(field, value) { 
    return function(x) {
        var parts = field.split('.');
        while (parts.length > 1 && defined(x)) {
            x = x[parts[0]];
            parts = parts.slice(1);
        }
        if (!defined(x)) {
            return false;
        }
        return x[parts[0]] === value;
    };
}

function getTypeProp(source, typeProp) {
// Yes, we really are going to parse an entire JS file using Esprima, and navigate all the way down the hierarchy just to identify the magic
// statement that looks like `return 'geojson';`
    try {
        var r = source.body.filter(eq('expression.callee.name', 'defineProperties'))[0] // inside a defineProperties block
            .expression.arguments[1].properties.filter(eq('key.name', typeProp))[0]     // a property of the form '<typeProp>: { ... }'
            .value.properties[0].value.body.body[0].argument.value;                     // ........... return 'thebitwewant';
        return r;
    } catch (e) {
        return undefined; // if there's no such statement, it's probably not a real CatalogItem type.
    }
}

// Is the commented type of this property something we can edit?
function supportedType(type) {
    return !!type.match(/^(Boolean|Number|String|Object|LegendUrl|Array(\.<(String|Number|Object|GetFeatureInfoFormat)>)?)$/i);
}

// For consistent behaviour, '@editortype' is expressed as if it were '@type', and we process it into a JSDoc internal type.
function fromEditorTypes(types) {
    // Support either '{Number} this is ignored' or 'Number' formats.
    var found = types.match(/(\{(.*)\})?(.*)/);
    return defaultValue(found[2], found[3]).split('|').map(function(type) {
        if (type === 'Number[]')
            return 'Array.<Number>';
        else if (type === 'String[]')
            return 'Array.<String>';
        else if (type === 'Object[]')
            return 'Array.<Object>';
        else return type;
    });
}

// convert JSDoc type to JSON Editor type
function editorType(type) {
    if (type.match(/Array/i)) {
        return 'array';
    } else if (type.match(/LegendUrl/i)) {
        return 'string';
    } else {
        return type.toLowerCase();
    }
}

// Given an array type, return the appropriate JSON Editor json.
function editorArrayItems(prop) {
    var type = {
        'Array.<String>': 'string',
        'Array.<Number>': 'number',
        'Array.<GetFeatureInfoFormat>': 'enum',
        'Array.<Object>': 'object',
        'Array': 'string'
    }[prop.type];
    if (!defined(type)) {
        throw 'Not an array type: ' + prop.type;
    }
    var items = {};
    items.type = getTag(prop, 'editoritemstype', type);
    items.title = getTag(prop, 'editoritemstitle');
    items.description = getTag(prop, 'editoritemsdescription');
    if (!argv.quiet && items.title) {
        console.log(items.title);
    }
    if (prop.type === 'Array.<GetFeatureInfoFormat>') {
        items.enum = [ 'json', 'xml', 'html', 'text' ];
    }
    return items;
}

// Search the whole input file just to find the line where the class inherits from CatalogItem/CatalogGroup.
// Takes a function(err, result) callback.
function findInherits(fulltext, filename) {

    var searchRE = /inherit\s*\(([A-Za-z0-9_-]+).*Catalog/;
    if (filename.match(/CatalogMember\.js/)) {
        // CatalogMember has no parent...
        searchRE = /defineProperties\(CatalogMember\.prototype/;
    }

    var lines = fulltext.split('\n');

    for (var i = 0; i < lines.length; i++) {
        // hmm, some inherit from ImageryLayerCatalogItem...
        var m = lines[i].match(searchRE);
        if (m) { 
            return { line: i, parent: m[1] };
        }
    }
    throw new Error("Couldn't find 'inherits' line in " + filename);
}

function findClassProp(comments, className, customTag, fallbackProp) {
    // Look for property 'customTag' in a comment on class 'className', else return property 'fallbackProp'
    // The comments before the main class seem to get split between a 'constructor' and 'class' kind. I don't know if
    // it's predictable, so we just look wherever.
    var r = comments.filter(eq('name', className)).reduce(function(val, x) {
        val = defaultValue(getTag(x, customTag, x[fallbackProp]), val);
        return val;
    }, undefined);
    return r;
}

// Get relevant properties on our class
function getClassProps(comments, className, inheritsLine) {
    return comments.filter(function(x) { 
        // we only want props defined directly on the object, not in defineProperties etc. Maybe.
        return x.kind === 'member' && x.memberof === className && x.meta.lineno < inheritsLine; 
    }).map(function(x) {
        x.type =  defined(x.type) ? x.type.names : [];
        if (x.type[0] === 'Rectangle') { // Yes, handling Rectangle is pretty messy.
            x.type = [ 'Array.<Number>', 'Array.<String>' ];
        }
        if (defined(getTag(x, 'editortype'))) { // this is not super robust.
            x.type = fromEditorTypes(getTag(x, 'editortype'));
        }
        return x;
    },this).filter(function(x) {
        // assume any defined editortype is safe.
        return getTag(x, 'editortype', x.type.some(supportedType));
    });
}

function unarray(arr) {
    return arr.length === 1 ? arr[0] : arr;
}

function specialProps(propName, p, className) {
    function clone(o) {
        return JSON.parse(JSON.stringify(o));
    }
    var specials = {
        'rectangle': {
            type: 'array',
            items: { 
                type: [ 'number', 'string' ]
            },
            format: 'table',
            options:  {
                collapsed: true,
                disable_array_reorder: true
            },
            maxItems: 4,
            minItems: 2
        },
        'blacklist': {
            additionalProperties: {
                type: 'boolean',
                format: 'checkbox'
            }
        },
        'whitelist': {
            additionalProperties: {
                type: 'boolean',
                format: 'checkbox'
            }
        }
    };
    if (specials[propName]) {
        Object.keys(specials[propName]).forEach(function(k) {
            p[k] = clone(specials[propName][k]);
        });
    }
    return p;
}

function replaceLinks(comment) {
    if (!defined(comment)) {
        return undefined;
    }
    return comment.replace(/\{@link ([^|}#]+)#([^}]*)\}/ig, "$1's $2")
        .replace(/\{@link ([^|}]+\|)?([^}]+)\}/ig, '$2');
}

function makeShellFile(model, mainOut, className, comments) {
    var out = {
        type: 'object',
        properties: {
            type: {
                options: { hidden: true },
                type: 'string',
                enum: [ model.typeId ]
            }

        },
        description: replaceLinks(findClassProp(comments, className, 'editordescription', 'description')),
        title: defaultValue(findClassProp(comments, className, 'editortitle'), model.typeName, className.replace(/Catalog(?!Member).*/, '')),
        // it seems redundant to include the ancestors again here, but it's needed for the editor to function.
        allOf: mainOut.allOf.concat({ $ref: model.name + '.json' } )
    };
    if (model.name === 'CatalogGroup') {
        // we're cheating a bit here.
        out.properties.items =  { "$ref": "items.json" };
    }    
    return out;
}
/**
 * Turns JSDoc comments attached to a catalog item model into schema properties.
 * @param  {Object} model    [description]
 * @param  {Object[]} comments [description]
 */
function processText(model, comments) {
    var className, cls = comments.filter(eq('kind', 'class'))[0];
    if (cls) { className = cls.name; } else { fatalError('No @class comment in ' + model.name); }

    /*** Generate JSON schema for the class-level parameters ***/
    var out = {
        type: 'object',
        defaultProperties: [
            'name', 'type', 'url' // do these always apply? Probably.
        ],
        properties: {}
    };
    if (model.name !== 'CatalogMember') { 
        out.allOf = [];
        if (model.name.match(/.CatalogItem$/)) {
            out.allOf.push({ $ref: 'CatalogItem.json' });
        } else if (model.name.match(/.CatalogGroup$/)) {
            out.allOf.push({ $ref: 'CatalogGroup.json' });
        }
        if (!model.parent.match(/^(CatalogItem|CatalogGroup|CatalogMember)$/)) {
            out.allOf.push({ $ref: model.parent + '.json' });
        }
        out.allOf.push({ $ref: 'CatalogMember.json' });
    }
    var props;
    try {
        props = getClassProps(comments, className, model.inheritsLine);
    } catch (e) {
        fatalError("Error getting class properties for class " + className, e);
    }

    /*** Generate JSON schema for each of the class properties. ***/
    props.forEach(function(x) {
        var p = {
            type: unarray(x.type.filter(supportedType).map(editorType)),
            title: getTag(x, 'editortitle', titleify(x.name)),
            description: replaceLinks(getTag(x, 'editordescription', x.description
                .replace(/^Gets or sets the/, 'The')
                .replace(/^Gets or sets a/, 'A')
                .replace(/\s*This property is observable./,'')))
        };
        if (p.type === 'array') {
            p.format = 'tabs';
            p.items = editorArrayItems(x);
        } else if (p.type === 'boolean') {
            p.format = 'checkbox';
        } else if (p.type === 'string' && p.name === 'description') {
            p.format = 'textarea';
        }

        p.format = getTag(x, 'editorformat', p.format);
        if (p.format === 'textarea') {
            p.options = { expand_height: true };
        }

        p = specialProps(x.name, p, className);
        out.properties[x.name] = p;
    });
    delete (out.properties.typeName);

    !argv.quiet && console.log(model.name + Array(32 - model.name.length).join(' ') +  Object.keys(out.properties).join(' '));
    model.outFile = argv.dest + '/' + model.name + '.json';
    if (model.typeId) {
        writeJson(argv.dest + '/' + model.name + '_type.json', makeShellFile(model, out, className, comments), showError);
    }
    model.description=undefined; //###testing
    model.title=undefined;
    writeJson(model.outFile, out, showError);
}

function showError(err) {
    if (!err) { 
        return;
    }
    console.error(JSON.stringify(err));
}

// Generate the contents of the special 'items' schema that says that each item in group can be any of the item types
// that we've processed today. Two very different formats depending on what 'editorMode' is set to.
function makeItemsFile(models, editorMode) {
    function sortModels(a, b) {
        return (a.$ref === 'CatalogGroup_type.json' ? -1 : 1);
    }
    function modelToItem(m) {
        
        // This seems convoluted, because it is. The logic is this:
        // Every item, for every catalog type, either:
        //   - a) does not have the type string; or
        //   - b) has the type string, and meet all the other requirements
        // We do it this way so that if an object fails part a), then any failure in part b) can instantly be flagged
        // as a genuine validation failure and alerted with useful context.
        typeProp = { 
            type: {
                enum: [ m.typeId ]
            }
        };
        if (!editorMode) return {
            oneOf: [
                { not: { properties: typeProp }
                },
                { allOf: [ 
                    // we have to put the type here (and not in the relevant schema file) in order to handle catalog types
                    // that inherit from other types. Eg, abs-itt inherits from csv, but a type field can't be both csv and abs-itt.
                    { properties: typeProp }, 
                    { $ref: m.name + '_type.json' } 
                ] }
            ]
        }; else 
            return { $ref: m.name + '_type.json' };
    }
    itemsOut = {
        title: 'Items',
        description: 'List of items or groups',
        type: 'array',
        format: 'tabs',
        items: {
            type: 'object',
            title: 'item',
            headerTemplate: '{{ self.name }}',
            required: [ 'name', 'type' ]
        }
    };
    if (editorMode) {
        // for the editor, we construct "oneOf" choices
        itemsOut.items.allOf = [{ $ref: 'CatalogMember.json' }];
        itemsOut.items.oneOf = models.map(function(m) { return { $ref: m.name + '_type.json' }; })
            .sort(sortModels);
    } else {
        // for validation, we use an overall "allOf" list, with pairs of allOf/not in binary opposition, to give most useful feedback.
        itemsOut.items.allOf = [ { $ref: 'CatalogMember.json' }].concat(models.map(modelToItem));
    }
    return itemsOut;
}

/**
 * Scan the code for a catalog item type and return a useful chunk of processed data.
 * @param  {Object}   model      Object with a filename property
 * @param  {Function} callback 
 * @param  {Boolean}  editorMode
 * @return {Object}   model
 */
function processModel(model, callback, editorMode) {
    fs.readFile(model.filename, 'utf8', function(err, data ){
        model.source = esprima.parse(data); // 1. Parse with esprima
        model.typeId = getTypeProp(model.source, 'type'); 
        if (!defined(model.typeId)) {
            // strip out any model that doesn't have a concrete static .type.
            // These are (hopefully all) intermediate classes like ImageryLayerCatalogItem
            !argv.quiet && console.log ('(' + model.name + ' has no type ID)');
        }
        try {
            var doc = jsdoc({src: model.filename}); // 2. parse from scratch with JSdoc
            m = findInherits(data, model.filename); // 3. simple text scan
            model.inheritsLine = m.line;
            model.parent = m.parent; 
            model.allText = '';
            model.typeName = getTypeProp(model.source, 'typeName');
            doc.on('data', function(chunk) {
                model.allText += chunk;
            });

            doc.on('end', function() { 
                try {
                    processText(model, JSON.parse(model.allText)); 
                    callback(undefined, model);
                } catch (e) {
                    fatalError('Error processing ' + model.filename, e);
                }

            });
        } catch (e) {
            callback(e, model);
        }        
    });
}

function makeDir(dir) {
    try {
        fs.mkdirSync(dir);
    } catch (e) {
        if (e.code === 'EEXIST') {
            return;
        }
        fatalError(e.code === 'ENOENT' ? 'Parent directory missing, so unable to create ' + dir : e.message, e);
    }
}

function writeJson(filename, json, callback) {
    return fs.writeFile(filename, JSON.stringify(json, null, argv.jsonIndent), 'utf8', callback);
}

/**
 * Generate schema and write to files.
 * @param  {Object} options Yargs-style object, including
 * * source: source directory
 * * dest: target directory
 * @return {[type]}         
 */
module.exports = function(options, callback) {
    function err(e) {
        showError(e);
        console.log('Schema writing finished.');        
    }
    argv = options;
    if (!argv || !argv.source || !argv.dest) {
        throw('Source and destination arguments required.');
    }
    makeDir(argv.dest);
    fs.readdir(argv.source + '/lib/Models', function(err, files) {
        var models=[];
        var processedModels = 0;
        files.filter(function(f) { 
            return f.match(/Catalog(Item|Group|Member)\.js$/) &&                   
                  !f.match(/(ArcGisMapServerCatalogGroup|addUserCatalogMember)/);
        }).forEach(function(f, i, arr) {
            processModel({
                name: f.replace(/\.js$/, ''),
                filename: argv.source + '/lib/Models/' + f
            }, function(err, model) {
                if (err) {
                    console.error('Fail: ' + model.filename);
                    console.error(err);
                } else if (defined(model.typeId)) {
                    models.push(model);
                }
                if (++processedModels === arr.length) {
                    writeJson(argv.dest + '/items.json', makeItemsFile(models, options.editor), err);
                }
            }, options.editor);
        });
    });

    // copy hardcoded JSON files
    fs.readdir(path.join(__dirname, 'src'), function(err, files) {
        files.forEach(function(file) {
            fs.readFile(path.join(__dirname, 'src', file), 'utf8', function(err, data) {
                fs.writeFile(path.join(argv.dest, file), data, 'utf8', function(err) {
                    if (!err) {
                        !argv.quiet && console.log('Copied ' + file);
                    } else {
                        throw(err);
                    }
                });
            });
        });
    });
};