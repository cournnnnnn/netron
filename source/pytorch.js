/* jshint esversion: 6 */

// Experimental

var pytorch = pytorch || {};
var base = base || require('./base');

pytorch.ModelFactory = class {

    match(context) {
        if (pytorch.Container.open(context)) {
            return true;
        }
        return false;
    }

    open(context, host) {
        const identifier = context.identifier;
        return host.require('./pickle').then((pickle) => {
            return host.require('./python').then((python) => {
                return pytorch.Metadata.open(host).then((metadata) => {
                    let container = null;
                    try {
                        container = pytorch.Container.open(context, metadata, pickle, python, (error, fatal) => {
                            const message = error && error.message ? error.message : error.toString();
                            host.exception(new pytorch.Error(message.replace(/\.$/, '') + " in '" + identifier + "'."), fatal);
                        });
                    }
                    catch (error) {
                        const message = error && error.message ? error.message : error.toString();
                        throw new pytorch.Error('File format is not PyTorch (' + message.replace(/\.$/, '') + ').');
                    }
                    return new pytorch.Model(metadata, container);
                });
            });
        });
    }
};

pytorch.Model = class {

    constructor(metadata, container) {
        this._format = container.format;
        this._producer = container.producer || '';
        this._graphs = [];
        const type = container.type;
        switch (type) {
            case 'script':
            case 'module':
                this._graphs.push(new pytorch.Graph(metadata, type, container.data, container));
                break;
            case 'weights':
                for (const data of container.data) {
                    this._graphs.push(new pytorch.Graph(metadata, type, data, container));
                }
                break;
        }
    }

    get format() {
        return this._format;
    }

    get graphs() {
        return this._graphs;
    }
};

pytorch.Graph = class {

    constructor(metadata, type, data, container) {
        this._nodes = [];
        this._inputs = [];
        this._outputs = [];
        this._groups = true;
        this._littleEndian = container.littleEndian;

        switch (type) {
            case 'script': {
                this._name = container.name;
                const traced = container.trace();
                const initializers = new Map();
                if (container.constants) {
                    for (const constant of container.constants) {
                        constant.initializer = new pytorch.Tensor(constant.__variable__, constant, this._littleEndian);
                        initializers.set(constant.__variable__, constant);
                    }
                }
                if (data) {
                    const queue = [ data ];
                    while (queue.length > 0) {
                        const module = queue.shift();
                        if (module.__module__ === '__torch__.torch.classes._nnapi' && module.__name__ === 'Compilation') {
                            continue;
                        }
                        for (const key of Object.keys(module)) {
                            if (key !== '__module__' && key !== '__name__' && key !== '__parent__') {
                                const obj = module[key];
                                if (!Array.isArray(obj) && obj === Object(obj)) {
                                    if (pytorch.Utility.isTensor(obj)) {
                                        const parameter = obj;
                                        parameter.__parent__ = module;
                                        if (!parameter.initializer && parameter.storage) {
                                            parameter.initializer = new pytorch.Tensor(parameter.name, parameter, this._littleEndian);
                                        }
                                        if (parameter.__variable__ && parameter.__count__ === 1) {
                                            initializers.set(parameter.__variable__, parameter);
                                        }
                                    }
                                    else if (obj && obj.__module__ && obj.__name__) {
                                        obj.__parent__ = module;
                                        if (!obj.__id__) {
                                            obj.__id__ = key;
                                        }
                                        queue.push(obj);
                                    }
                                }
                            }
                        }
                    }
                }
                if (traced) {
                    if (container.inputs) {
                        for (const input of container.inputs) {
                            this._inputs.push(new pytorch.Parameter(input, true, [
                                new pytorch.Argument(input, null, null)
                            ]));
                        }
                    }
                    if (container.outputs) {
                        for (const output of container.outputs) {
                            this._outputs.push(new pytorch.Parameter(output, true, [
                                new pytorch.Argument(output, null, null)
                            ]));
                        }
                    }
                    if (container.nodes) {
                        for (const node of container.nodes) {
                            const item = {
                                type: node.type,
                                node: node
                            };
                            this._nodes.push(new pytorch.Node(metadata, '', item, initializers));
                        }
                    }
                }
                if (data) {
                    this._loadScriptModule(metadata, container, data, initializers);
                }
                break;
            }
            case 'module': {
                this._type = (data.__module__ && data.__name__) ? (data.__module__ + '.' + data.__name__) : '';
                this._loadModule(metadata, container.data, [], []);
                break;
            }
            case 'weights': {
                this._name = data.name || '';
                for (const state_group of data.layers) {
                    const attributes = state_group.attributes || [];
                    const inputs = state_group.states.map((parameter) => {
                        return new pytorch.Parameter(parameter.name, true,
                            parameter.arguments.map((state) => {
                                const tensor = new pytorch.Tensor(state.id, pytorch.Utility.toTensor(state.value), this._littleEndian);
                                return new pytorch.Argument(state.id, null, tensor);
                            }));
                    });
                    const obj = {
                        name: state_group.name,
                        type: state_group.type || 'torch.nn.Module',
                        attributes: attributes,
                        inputs: inputs,
                        outputs: []
                    };
                    this._nodes.push(new pytorch.Node(metadata, '', obj, null));
                }
            }
        }
    }

    _loadModule(metadata, current, groups, inputs) {

        if (current.__module__ && current.__module__ !== 'torch.nn.modules.container' && (!current._modules || current._modules.size == 0)) {
            this._createNode(metadata, groups, '', current, inputs, false);
            return [];
        }

        if (!current._modules) {
            throw new pytorch.Error('Module does not contain modules.');
        }

        const sequential = current.__module__ === 'torch.nn.modules.container' && current.__name__ === 'Sequential';

        for (const pair of current._modules) {
            const key = pair[0];
            const value = pair[1];
            if (value) {
                const type = value.__module__ + '.' + value.__name__;
                switch (type) {
                    case 'torch.nn.modules.container.Sequential':
                        groups.push(key);
                        inputs = this._loadModule(metadata, value, groups, sequential ? inputs : []);
                        groups.pop(key);
                        break;
                    default: {
                        inputs = this._createNode(metadata, groups, key, value, sequential ? inputs : [], sequential);
                        break;
                    }
                }
            }
        }
        return inputs;
    }

    _createNode(metadata, groups, key, obj, args, output) {

        const type = obj.__module__ + '.' + obj.__name__;
        const schema = metadata.type(type);

        let inputSchema = [ { name: 'input'} ];
        if (schema && schema.inputs && schema.inputs.length > 0) {
            inputSchema = schema.inputs.slice();
        }

        const inputName = inputSchema.shift().name;
        const inputs = [];
        if (args.length > 0) {
            inputs.push(new pytorch.Parameter(inputName, true, args.map((argument) => {
                return new pytorch.Argument(argument, null, null);
            })));
        }

        const parameters = obj._parameters || obj._buffers || [];
        for (const parameter of parameters) {
            const key = parameter[0];
            const value = pytorch.Utility.toTensor(parameter[1]);
            let visible = true;
            let inputName = '';
            if (inputSchema.length > 0) {
                const input = inputSchema.shift();
                inputName = input.name;
                visible = input.visible === false ? false : true;
            }
            if (value) {
                const initializer = new pytorch.Tensor('', value, this._littleEndian);
                inputs.push(new pytorch.Parameter(inputName || key, visible, [ new pytorch.Argument('', null, initializer) ]));
            }
        }

        const group = groups.join('/');
        const name = group ? (group + '/' + key) : key;

        const outputs = output ? [ new pytorch.Parameter('output', true, [ new pytorch.Argument(name, null, null) ]) ] : [];

        const attributes = [];
        for (const name of Object.keys(obj)) {
            if (name.startsWith('_')) {
                continue;
            }
            attributes.push({ name: name, value: obj[name] });
        }
        const item = {
            name: name,
            type: type,
            attributes: attributes,
            inputs: inputs,
            outputs: outputs
        };
        const node = new pytorch.Node(metadata, group, item, {});
        this._nodes.push(node);
        return [ node.name ];
    }

    _loadScriptModule(metadata, container, module, initializers) {
        if (module) {
            if (pytorch.Graph._getParameters(module).length > 0 && !module.__hide__) {
                const item = { module: module };
                this._nodes.push(new pytorch.Node(metadata, '', item, initializers));
            }
            const submodules = pytorch.Graph._getSubmodules(module);
            for (const submodule of submodules) {
                this._loadScriptModule(metadata, container, submodule, initializers);
            }
        }
    }

    static _getParameters(module) {
        const parameters = [];
        if (module && module.__module__ && module.__name__) {
            for (const key of Object.keys(module)) {
                if (pytorch.Utility.isTensor(module[key])) {
                    const parameter = module[key];
                    parameter.__id__ = key;
                    parameters.push(parameter);
                }
            }
        }
        return parameters;
    }

    static _getSubmodules(module) {
        const submodules = [];
        if (module && module.__module__ && module.__name__) {
            for (const key of Object.keys(module)) {
                if (!key.startsWith('__')) {
                    const value = module[key];
                    if (value && value.__module__ && value.__name__ && !pytorch.Utility.isTensor(value)) {
                        submodules.push(value);
                    }
                }
            }
        }
        return submodules;
    }

    get type() {
        return this._type;
    }

    get name() {
        return this._name;
    }

    get groups() {
        return this._groups;
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }

    get nodes() {
        return this._nodes;
    }
};

pytorch.Parameter = class {

    constructor(name, visible, args) {
        this._name = name;
        this._visible = visible;
        this._arguments = args;
    }

    get name() {
        return this._name;
    }

    get visible() {
        return this._visible;
    }

    get arguments() {
        return this._arguments;
    }
};

pytorch.Argument = class {

    constructor(name, type, initializer) {
        if (typeof name !== 'string') {
            throw new pytorch.Error("Invalid argument identifier '" + JSON.stringify(name) + "'.");
        }
        this._name = name;
        this._type = type;
        this._initializer = initializer;
    }

    get name() {
        return this._name;
    }

    get type() {
        if (this._initializer) {
            return this._initializer.type;
        }
        return this._type;
    }

    get initializer() {
        return this._initializer;
    }
};

pytorch.Node = class {

    constructor(metadata, group, item, initializers) {
        this._metadata = metadata;
        this._group = group || '';
        this._name = item.name || '';

        if (!item.module && !item.node) {
            this._type = item.type;
            this._inputs = item.inputs;
            this._outputs = item.outputs;
            this._attributes = item.attributes.map((attribute) => {
                const schema = metadata.attribute(this._type, attribute.name);
                return new pytorch.Attribute(schema, attribute.name, attribute.value);
            });
        }
        else {
            this._attributes = [];
            this._inputs = [];
            this._outputs = [];

            let module = item.module;
            if (module) {
                this._type = 'torch.nn.modules.module.Module';
                for (const parameter of pytorch.Graph._getParameters(module)) {
                    this._inputs.push(new pytorch.Parameter(parameter.__id__, true, [
                        new pytorch.Argument('', null, parameter.initializer || null)
                    ]));
                    if (parameter.__variable__) {
                        this._outputs.push(new pytorch.Parameter(parameter.__id__, true, [
                            new pytorch.Argument(parameter.__variable__, null, null)
                        ]));
                    }
                }
            }

            if (item.node) {
                this._type = item.type;
                const schema = metadata.type(this._type);
                module = null;
                let match = true;
                let count = 0;
                for (const input of item.node.inputs) {
                    for (const argument of input) {
                        const parameter = initializers.get(argument.id);
                        if (parameter) {
                            if (parameter.__parent__ && (module == null || module == parameter.__parent__)) {
                                module = parameter.__parent__;
                                count++;
                            }
                            else if (parameter.__variable__.startsWith('CONSTANTS.c')) {
                                argument.initializer = parameter.initializer;
                                count++;
                            }
                            else {
                                match = false;
                                break;
                            }
                        }
                    }
                    if (!match) {
                        break;
                    }
                }
                if (module) {
                    const params = pytorch.Graph._getParameters(module).filter((p) => p.__id__ !== 'num_batches_tracked');
                    if (params.length == count && match) {
                        module.__hide__ = true;
                        for (const input of item.node.inputs) {
                            for (const argument of input) {
                                const parameter = initializers.get(argument.id);
                                if (parameter && parameter.initializer) {
                                    argument.initializer = parameter.initializer;
                                }
                            }
                        }
                    }
                    else {
                        module = null;
                    }
                }

                for (let inputIndex = 0; inputIndex < item.node.inputs.length; inputIndex++) {
                    let inputName = inputIndex.toString();
                    if (schema && schema.inputs && schema.inputs.length > inputIndex) {
                        inputName = schema.inputs[inputIndex].name;
                    }
                    this._inputs.push(new pytorch.Parameter(inputName, true,
                        item.node.inputs[inputIndex].map((input) => new pytorch.Argument(input.id, null, input.initializer || null))
                    ));
                }

                for (let outputIndex = 0; outputIndex < item.node.outputs.length; outputIndex++) {
                    let outputName = outputIndex.toString();
                    if (schema && schema.outputs && schema.outputs.length > outputIndex) {
                        outputName = schema.outputs[outputIndex].name;
                    }
                    this._outputs.push(new pytorch.Parameter(outputName, true,
                        item.node.outputs[outputIndex].map((output) => new pytorch.Argument(output.id, null, null))
                    ));
                }

                for (const attribute of item.node.attributes) {
                    const name = attribute.name;
                    const value = attribute.value;
                    const schema = metadata.attribute(this._type, name);
                    this._attributes.push(new pytorch.Attribute(schema, name, value));
                }
            }
            if (module) {
                if (module.__id__) {
                    let current = module;
                    this._name = current.__id__;
                    while (current.__parent__ != null) {
                        current = current.__parent__;
                        if (!current.__parent__ && !current.__id__) {
                            break;
                        }
                        this._name = [ current.__id__, this._name ].join('.');
                    }
                }
            }
        }
    }

    get name() {
        return this._name;
    }

    get group() {
        return this._group;
    }

    get type() {
        const index = this._type.indexOf(':');
        return index === -1 ? this._type : this._type.substring(0, index);
    }

    get metadata() {
        return this._metadata.type(this._type);
    }

    get function() {
        return this._type.startsWith('torch.nn.modules.') && this._type !== 'torch.nn.modules.module.Module';
    }

    get attributes() {
        return this._attributes;
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }
};

pytorch.Attribute = class {

    constructor(schema, name, value) {
        this._name = name;
        this._value = value;

        if (this._name === 'training') {
            this._visible = false;
            this._type = 'boolean';
            return;
        }
        if (schema) {
            if (Object.prototype.hasOwnProperty.call(schema, 'type')) {
                this._type = schema.type;
            }
            if (schema.visible === false) {
                this._visible = false;
            }
            else if (Object.prototype.hasOwnProperty.call(schema, 'default')) {
                if (JSON.stringify(schema.default) == JSON.stringify(this._value)) {
                    this._visible = false;
                }
                else if (Array.isArray(this._value) && !Array.isArray(schema.default) && this.value.every((item) => item == schema.default)) {
                    this._visible = false;
                }
            }
        }
        if (Array.isArray(value) && value.length > 0 && value.every((obj) => obj && obj.__module__ && obj.__module__.startsWith('torch.nn'))) {
            this._value = '?';
        }
    }

    get type() {
        return this._type;
    }

    get name() {
        return this._name;
    }

    get value() {
        return this._value;
    }

    get visible() {
        return this._visible == false ? false : true;
    }
};

pytorch.Tensor = class {

    constructor(name, tensor, littleEndian) {
        this._name = name || '';
        this._type = new pytorch.TensorType(tensor.storage.dataType, new pytorch.TensorShape(tensor.size));
        this._data = tensor.storage.data;
        this._littleEndian = littleEndian;
    }

    get kind() {
        return 'Tensor';
    }

    get name() {
        return this._name;
    }

    get type() {
        return this._type;
    }

    get state() {
        return this._context().state;
    }

    get value() {
        const context = this._context();
        if (context.state) {
            return null;
        }
        context.limit = Number.MAX_SAFE_INTEGER;
        return this._decode(context, 0);
    }

    toString() {
        const context = this._context();
        if (context.state) {
            return '';
        }
        context.limit = 10000;
        const value = this._decode(context, 0);
        return pytorch.Tensor._stringify(value, '', '    ');
    }

    _context() {
        const context = {};
        context.state = null;
        context.index = 0;
        context.count = 0;

        if (!this._type.dataType) {
            context.state = 'Tensor has no data type.';
            return context;
        }
        switch (this._type.dataType) {
            case 'boolean':
            case 'uint8':
            case 'qint8':
            case 'int8':
            case 'int16':
            case 'int32':
            case 'int64':
            case 'float16':
            case 'float32':
            case 'float64':
                break;
            default:
                context.state = "Tensor data type '" + this._type.dataType + "' is not supported.";
                return context;
        }
        if (!this._type.shape) {
            context.state = 'Tensor has no dimensions.';
            return context;
        }
        if (!this._data) {
            context.state = 'Tensor data is empty.';
            return context;
        }

        context.data = this._data;
        context.dataType = this._type.dataType;
        context.dimensions = this._type.shape.dimensions;
        context.dataView = new DataView(context.data.buffer, context.data.byteOffset, context.data.byteLength);
        return context;
    }

    _decode(context, dimension) {
        const results = [];
        const dimensions = (context.dimensions.length == 0) ? [ 1 ] : context.dimensions;
        const size = dimensions[dimension];
        if (dimension == dimensions.length - 1) {
            for (let i = 0; i < size; i++) {
                if (context.count > context.limit) {
                    results.push('...');
                    return results;
                }
                switch (context.dataType) {
                    case 'boolean':
                        results.push(context.dataView.getUint8(context.index) === 0 ?  false : true);
                        context.index++;
                        context.count++;
                        break;
                    case 'uint8':
                        results.push(context.dataView.getUint8(context.index));
                        context.index++;
                        context.count++;
                        break;
                    case 'qint8':
                    case 'int8':
                        results.push(context.dataView.getInt8(context.index));
                        context.index++;
                        context.count++;
                        break;
                    case 'int16':
                        results.push(context.dataView.getInt16(context.index, this._littleEndian));
                        context.index += 2;
                        context.count++;
                        break;
                    case 'int32':
                        results.push(context.dataView.getInt32(context.index, this._littleEndian));
                        context.index += 4;
                        context.count++;
                        break;
                    case 'int64':
                        results.push(context.dataView.getInt64(context.index, this._littleEndian));
                        context.index += 8;
                        context.count++;
                        break;
                    case 'float16':
                        results.push(context.dataView.getFloat16(context.index, this._littleEndian));
                        context.index += 2;
                        context.count++;
                        break;
                    case 'float32':
                        results.push(context.dataView.getFloat32(context.index, this._littleEndian));
                        context.index += 4;
                        context.count++;
                        break;
                    case 'float64':
                        results.push(context.dataView.getFloat64(context.index, this._littleEndian));
                        context.index += 8;
                        context.count++;
                        break;
                }
            }
        }
        else {
            for (let j = 0; j < size; j++) {
                if (context.count > context.limit) {
                    results.push('...');
                    return results;
                }
                results.push(this._decode(context, dimension + 1));
            }
        }
        if (context.dimensions.length == 0) {
            return results[0];
        }
        return results;
    }

    static _stringify(value, indentation, indent) {
        if (Array.isArray(value)) {
            const result = [];
            result.push(indentation + '[');
            const items = value.map((item) => pytorch.Tensor._stringify(item, indentation + indent, indent));
            if (items.length > 0) {
                result.push(items.join(',\n'));
            }
            result.push(indentation + ']');
            return result.join('\n');
        }
        if (value && (value instanceof base.Int64 || value instanceof base.Uint64)) {
            return indentation + value.toString();
        }
        if (typeof value == 'string') {
            return indentation + value;
        }
        if (value == Infinity) {
            return indentation + 'Infinity';
        }
        if (value == -Infinity) {
            return indentation + '-Infinity';
        }
        if (isNaN(value)) {
            return indentation + 'NaN';
        }
        return indentation + value.toString();
    }
};

pytorch.TensorType = class {

    constructor(dataType, shape) {
        this._dataType = dataType;
        this._shape = shape;
    }

    get dataType() {
        return this._dataType;
    }

    get shape() {
        return this._shape;
    }

    toString() {
        return this._dataType + this._shape.toString();
    }
};

pytorch.TensorShape = class {

    constructor(dimensions) {
        this._dimensions = dimensions || [];
    }

    get dimensions() {
        return this._dimensions;
    }

    toString() {
        if (this._dimensions && this._dimensions.length > 0) {
            return '[' + this._dimensions.map((dimension) => dimension.toString()).join(',') + ']';
        }
        return '';
    }
};

pytorch.Execution = class {

    constructor(python, sources, exceptionCallback) {
        const self = this;
        this._python = python;
        this._sources = sources || new Map();
        this._exceptionCallback = exceptionCallback;
        this._utf8Decoder = new TextDecoder('utf-8');
        this._unknownNameMap = new Set();
        this._knownPackageMap = new Set([ 'torch', 'torchvision', 'collections', '__builtin__', '_codecs', 'argparse', 'numpy' ]);
        this._packages = new Map();
        this._context = new pytorch.Execution.Context();
        this._context.scope.builtins = {};
        this._context.scope.builtins.type = { __module__: 'builtins', __name__: 'type' };
        this._context.scope.builtins.module = { __module__: 'builtins', __name__: 'module', __class__: this._context.scope.builtins.type };
        this._context.scope.builtins.function = { __module__: 'builtins', __name__: 'function', __class__: this._context.scope.builtins.type };
        this._context.scope.builtins.method = { __module__: 'builtins', __name__: 'method', __class__: this._context.scope.builtins.type };
        this._context.scope.builtins.dict = { __module__: 'builtins', __name__: 'dict', __class__: this._context.scope.builtins.type };
        this._context.scope.builtins.list = { __module__: 'builtins', __name__: 'list', __class__: this._context.scope.builtins.type };
        this._context.scope.builtins.bool = { __module__: 'builtins', __name__: 'bool', __class__: this._context.scope.builtins.type };
        this._context.scope.builtins.int = { __module__: 'builtins', __name__: 'int', __class__: this._context.scope.builtins.type };
        this._context.scope.builtins.float = { __module__: 'builtins', __name__: 'float', __class__: this._context.scope.builtins.type };
        this._context.scope.builtins.str = { __module__: 'builtins', __name__: 'str', __class__: this._context.scope.builtins.type };
        this._context.scope.builtins.tuple = { __module__: 'builtins', __name__: 'tuple', __class__: this._context.scope.builtins.type };
        this._context.scope.typing = { __name__: 'typing', __class__: this._context.scope.builtins.module };
        this._context.scope.typing._GenericAlias = { __module__: 'typing', __name__: '_GenericAlias', __class__: this._context.scope.builtins.type };
        this._context.scope.typing._SpecialForm = { __module__: 'typing', __name__: '_SpecialForm', __class__: this._context.scope.builtins.type };
        this._context.scope.typing._VariadicGenericAlias = { __module__: 'typing', __name__: '_VariadicGenericAlias', __class__: this._context.scope.builtins.type };
        this._context.scope.typing.Dict = { __module__: 'typing', _name: 'Dict', __class__: this._context.scope.typing._VariadicGenericAlias, __origin__: this._context.scope.builtins.dict };
        this._context.scope.typing.List = { __module__: 'typing', _name: 'List', __class__: this._context.scope.typing._GenericAlias, __origin__: this._context.scope.builtins.list };
        this._context.scope.typing.Optional = { __module__: 'typing', _name: 'Optional', __class__: this._context.scope.typing._SpecialForm };
        this._context.scope.typing.Tuple = { __module__: 'typing', _name: 'Tuple', __class__: this._context.scope.typing._GenericAlias, __origin__: this._context.scope.builtins.tuple };
        this._context.scope.torch = { __name__: 'torch', __class__: this._context.scope.builtins.module };
        this._context.scope.torch.Tensor = { __module__: 'torch', __name__: 'Tensor', __class__: this._context.scope.builtins.type };
        this._registerConstructor('__torch__.torch.classes._nnapi.Compilation', function () {
            this.__hide__ = true;
            this.__init__ = function() {
            };
            this.init = function(serialized_model_tensor, parameter_buffers) {
                this.serialized_model_tensor = serialized_model_tensor;
                this.parameter_buffers = parameter_buffers;
                new pytorch.nnapi.SerializedModel(serialized_model_tensor.storage.data, parameter_buffers);
            };
            this.run = function(inputs, outputs) {
                this.serialized_model_tensor.__variable__ = this.serialized_model_tensor.__variable__ || self.variable();
                this.serialized_model_tensor.__count__ = (this.serialized_model_tensor.__count__ || 0) + 1;
                self.push({
                    type: 'torch.classes._nnapi.Compilation',
                    attributes: [],
                    inputs: [
                        [ { id: this.serialized_model_tensor.__variable__ } ],
                        inputs.map((input) => { return { id: input.__variable__ }; }),
                        this.parameter_buffers.map((buffer) => { return { id: buffer.__variable__ }; })
                    ],
                    outputs: [
                        outputs.map((output) => { return { id: output.__variable__ }; })
                    ],
                });
            };
        });
        this._registerConstructor('argparse.Namespace', function (args) {
            this.args = args;
        });
        this._registerConstructor('torch.autograd.variable.Variable', function() {});
        this._registerConstructor('torch.backends.cudnn.rnn.Unserializable', function() {});
        this._registerConstructor('torch.device', function(type, index) {
            this.type = type;
            if (index) {
                this.index = index;
            }
        });
        this._registerConstructor('torch.distributions.multivariate_normal.MultivariateNormal', function() {});
        this._registerConstructor('torch.distributions.transforms.LowerCholeskyTransform', function() {});
        this._registerConstructor('torch.nn.backends.thnn._get_thnn_function_backend', function() {});
        this._registerConstructor('torch.nn.intrinsic.modules.fused.ConvReLU2d', function() {});
        this._registerConstructor('torch.nn.intrinsic.quantized.modules.conv_relu.ConvReLU2d', function() {});
        this._registerConstructor('torch.nn.modules.activation.CELU', function() {});
        this._registerConstructor('torch.nn.modules.activation.ELU', function() {});
        this._registerConstructor('torch.nn.modules.activation.GELU', function() {});
        this._registerConstructor('torch.nn.modules.activation.GLU', function() {});
        this._registerConstructor('torch.nn.modules.activation.Hardtanh', function() {});
        this._registerConstructor('torch.nn.modules.activation.Hardswish', function() {});
        this._registerConstructor('torch.nn.modules.activation.Hardsigmoid', function() {});
        this._registerConstructor('torch.nn.modules.activation.LeakyReLU', function() {});
        this._registerConstructor('torch.nn.modules.activation.LogSigmoid', function() {});
        this._registerConstructor('torch.nn.modules.activation.LogSoftmax', function() {});
        this._registerConstructor('torch.nn.modules.activation.MultiheadAttention', function() {});
        this._registerConstructor('torch.nn.modules.activation.ReLU', function() {});
        this._registerConstructor('torch.nn.modules.activation.ReLU6', function() {});
        this._registerConstructor('torch.nn.modules.activation.PReLU', function() {});
        this._registerConstructor('torch.nn.modules.activation.RReLU', function() {});
        this._registerConstructor('torch.nn.modules.activation.SELU', function() {});
        this._registerConstructor('torch.nn.modules.activation.Sigmoid', function() {});
        this._registerConstructor('torch.nn.modules.activation.Softmax', function() {});
        this._registerConstructor('torch.nn.modules.activation.Softmax2d', function() {});
        this._registerConstructor('torch.nn.modules.activation.Softplus', function() {});
        this._registerConstructor('torch.nn.modules.activation.Tanh', function() {});
        this._registerConstructor('torch.nn.modules.activation.Threshold', function() {});
        this._registerConstructor('torch.nn.modules.batchnorm.BatchNorm1d', function() {});
        this._registerConstructor('torch.nn.modules.batchnorm.BatchNorm2d', function() {});
        this._registerConstructor('torch.nn.modules.batchnorm.BatchNorm3d', function() {});
        this._registerConstructor('torch.nn.modules.batchnorm.SyncBatchNorm', function() {});
        this._registerConstructor('torch.nn.modules.container.ModuleDict', function() {});
        this._registerConstructor('torch.nn.modules.container.ModuleList', function() {});
        this._registerConstructor('torch.nn.modules.container.ParameterList', function() {});
        this._registerConstructor('torch.nn.modules.container.Sequential', function() {});
        this._registerConstructor('torch.nn.modules.conv.Conv1d', function() {});
        this._registerConstructor('torch.nn.modules.conv.Conv2d', function() {});
        this._registerConstructor('torch.nn.modules.conv.Conv3d', function() {});
        this._registerConstructor('torch.nn.modules.conv.ConvTranspose1d', function() {});
        this._registerConstructor('torch.nn.modules.conv.ConvTranspose2d', function() {});
        this._registerConstructor('torch.nn.modules.conv.ConvTranspose3d', function() {});
        this._registerConstructor('torch.nn.modules.distance.CosineSimilarity', function() {});
        this._registerConstructor('torch.nn.modules.dropout.Dropout', function() {});
        this._registerConstructor('torch.nn.modules.dropout.Dropout2d', function() {});
        this._registerConstructor('torch.nn.modules.dropout.Dropout3d', function() {});
        this._registerConstructor('torch.nn.modules.fold.Unfold', function() {});
        this._registerConstructor('torch.nn.modules.flatten.Flatten', function() {});
        this._registerConstructor('torch.nn.modules.instancenorm.InstanceNorm1d', function() {});
        this._registerConstructor('torch.nn.modules.instancenorm.InstanceNorm2d', function() {});
        this._registerConstructor('torch.nn.modules.instancenorm.InstanceNorm3d', function() {});
        this._registerConstructor('torch.nn.modules.linear._LinearWithBias', function() {});
        this._registerConstructor('torch.nn.modules.linear.Bilinear', function() {});
        this._registerConstructor('torch.nn.modules.linear.Linear', function() {});
        this._registerConstructor('torch.nn.modules.linear.Identity', function() {});
        this._registerConstructor('torch.nn.modules.loss.BCELoss', function() {});
        this._registerConstructor('torch.nn.modules.loss.BCEWithLogitsLoss', function() {});
        this._registerConstructor('torch.nn.modules.loss.CrossEntropyLoss', function() {});
        this._registerConstructor('torch.nn.modules.loss.L1Loss', function() {});
        this._registerConstructor('torch.nn.modules.loss.MarginRankingLoss', function() {});
        this._registerConstructor('torch.nn.modules.loss.MSELoss', function() {});
        this._registerConstructor('torch.nn.modules.loss.NLLLoss', function() {});
        this._registerConstructor('torch.nn.modules.loss.NLLLoss2d', function() {});
        this._registerConstructor('torch.nn.modules.loss.SmoothL1Loss', function() {});
        this._registerConstructor('torch.nn.modules.module._IncompatibleKeys', function() {});
        this._registerConstructor('torch.nn.modules.module.Module', function() {});
        this._registerConstructor('torch.nn.modules.normalization.CrossMapLRN2d', function() {});
        this._registerConstructor('torch.nn.modules.normalization.GroupNorm', function() {});
        this._registerConstructor('torch.nn.modules.normalization.LayerNorm', function() {});
        this._registerConstructor('torch.nn.modules.normalization.LocalResponseNorm', function() {});
        this._registerConstructor('torch.nn.modules.padding.ReflectionPad1d', function() {});
        this._registerConstructor('torch.nn.modules.padding.ReflectionPad2d', function() {});
        this._registerConstructor('torch.nn.modules.padding.ReplicationPad1d', function() {});
        this._registerConstructor('torch.nn.modules.padding.ReplicationPad2d', function() {});
        this._registerConstructor('torch.nn.modules.padding.ReplicationPad3d', function() {});
        this._registerConstructor('torch.nn.modules.padding.ZeroPad2d', function() {});
        this._registerConstructor('torch.nn.modules.padding.ConstantPad1d', function() {});
        this._registerConstructor('torch.nn.modules.padding.ConstantPad2d', function() {});
        this._registerConstructor('torch.nn.modules.padding.ConstantPad3d', function() {});
        this._registerConstructor('torch.nn.modules.pixelshuffle.PixelShuffle', function() {});
        this._registerConstructor('torch.nn.modules.pooling.AdaptiveAvgPool1d', function() {});
        this._registerConstructor('torch.nn.modules.pooling.AdaptiveAvgPool2d', function() {});
        this._registerConstructor('torch.nn.modules.pooling.AdaptiveAvgPool3d', function() {});
        this._registerConstructor('torch.nn.modules.pooling.AdaptiveMaxPool1d', function() {});
        this._registerConstructor('torch.nn.modules.pooling.AdaptiveMaxPool2d', function() {});
        this._registerConstructor('torch.nn.modules.pooling.AdaptiveMaxPool3d', function() {});
        this._registerConstructor('torch.nn.modules.pooling.AvgPool1d', function() {});
        this._registerConstructor('torch.nn.modules.pooling.AvgPool2d', function() {});
        this._registerConstructor('torch.nn.modules.pooling.AvgPool3d', function() {});
        this._registerConstructor('torch.nn.modules.pooling.FractionalMaxPool2d', function() {});
        this._registerConstructor('torch.nn.modules.pooling.LPPool2d', function() {});
        this._registerConstructor('torch.nn.modules.pooling.MaxPool1d', function() {});
        this._registerConstructor('torch.nn.modules.pooling.MaxPool2d', function() {});
        this._registerConstructor('torch.nn.modules.pooling.MaxPool3d', function() {});
        this._registerConstructor('torch.nn.modules.pooling.MaxUnpool1d', function() {});
        this._registerConstructor('torch.nn.modules.pooling.MaxUnpool2d', function() {});
        this._registerConstructor('torch.nn.modules.pooling.MaxUnpool3d', function() {});
        this._registerConstructor('torch.nn.modules.rnn.GRU', function() {});
        this._registerConstructor('torch.nn.modules.rnn.GRUCell', function() {});
        this._registerConstructor('torch.nn.modules.rnn.LSTM', function() {});
        this._registerConstructor('torch.nn.modules.rnn.LSTMCell', function() {});
        this._registerConstructor('torch.nn.modules.rnn.RNN', function() {});
        this._registerConstructor('torch.nn.modules.sparse.Embedding', function() {});
        this._registerConstructor('torch.nn.modules.sparse.EmbeddingBag', function() {});
        this._registerConstructor('torch.nn.modules.transformer.Transformer', function() {});
        this._registerConstructor('torch.nn.modules.transformer.TransformerDecoder', function() {});
        this._registerConstructor('torch.nn.modules.transformer.TransformerDecoderLayer', function() {});
        this._registerConstructor('torch.nn.modules.transformer.TransformerEncoder', function() {});
        this._registerConstructor('torch.nn.modules.transformer.TransformerEncoderLayer', function() {});
        this._registerConstructor('torch.nn.modules.upsampling.Upsample', function() {});
        this._registerConstructor('torch.nn.modules.upsampling.UpsamplingBilinear2d', function() {});
        this._registerConstructor('torch.nn.modules.upsampling.UpsamplingNearest2d', function() {});
        this._registerConstructor('torch.nn.parallel.data_parallel.DataParallel', function() {});
        this._registerConstructor('torch.nn.parallel.distributed.DistributedDataParallel', function() {});
        this._registerConstructor('torch.nn.parameter.Parameter', function(data, requires_grad) {
            if (data !== undefined) {
                this.data = data;
            }
            this.requires_grad = requires_grad !== undefined ? requires_grad : true;
            this.__setstate__ = function(state) {
                switch (state.length) {
                    case 4:
                        this.data = state[0];
                        break;
                    case 5:
                        this.data = state[0];
                        break;
                }
            };
        });
        this._registerConstructor('torch.nn.quantized.modules.activation.ReLU', function() {});
        this._registerConstructor('torch.nn.quantized.modules.batchnorm.BatchNorm2d', function() {});
        this._registerConstructor('torch.nn.quantized.modules.conv.Conv2d', function() {});
        this._registerConstructor('torch.nn.quantized.modules.DeQuantize', function() {});
        this._registerConstructor('torch.nn.quantized.modules.functional_modules.FloatFunctional', function() {});
        this._registerConstructor('torch.nn.quantized.modules.functional_modules.QFunctional', function() {});
        this._registerConstructor('torch.nn.quantized.modules.linear.Linear', function() {});
        this._registerConstructor('torch.nn.quantized.modules.linear.LinearPackedParams', function() {});
        this._registerConstructor('torch.nn.quantized.modules.Quantize', function() {});
        this._registerConstructor('torch.nn.utils.spectral_norm.SpectralNorm', function() {});
        this._registerConstructor('torch.nn.utils.spectral_norm.SpectralNormStateDictHook', function() {});
        this._registerConstructor('torch.nn.utils.spectral_norm.SpectralNormLoadStateDictPreHook', function() {});
        this._registerConstructor('torch.nn.utils.weight_norm.WeightNorm', function() {});
        this._registerConstructor('torch.optim.adam.Adam', function() {});
        this._registerConstructor('torch.optim.adagrad.Adagrad', function() {});
        this._registerConstructor('torch.optim.adadelta.Adadelta', function() {});
        this._registerConstructor('torch.optim.lr_scheduler.CosineAnnealingLR', function() {});
        this._registerConstructor('torch.optim.lr_scheduler.CyclicLR', function() {});
        this._registerConstructor('torch.optim.lr_scheduler.ExponentialLR', function() {});
        this._registerConstructor('torch.optim.lr_scheduler.LambdaLR', function() {});
        this._registerConstructor('torch.optim.lr_scheduler.MultiStepLR', function() {});
        this._registerConstructor('torch.optim.lr_scheduler.StepLR', function() {});
        this._registerConstructor('torch.optim.optimizer._RequiredParameter', function() {});
        this._registerConstructor('torch.optim.rmsprop.RMSprop', function() {});
        this._registerConstructor('torch.optim.sgd.SGD', function() {});
        this._registerConstructor('torch.quantization.observer._PartialWrapper', function() {});
        this._registerConstructor('torch.quantization.observer.MinMaxObserver', function() {});
        this._registerConstructor('torch.quantization.QConfig.QConfig', function() {});
        this._registerConstructor('torch.quantization.stubs.DeQuantStub', function() {});
        this._registerConstructor('torch.quantization.stubs.QuantStub', function() {});
        this._registerConstructor('torch.utils.data.dataloader.DataLoader', function() {});
        this._registerConstructor('torch.utils.data.dataset.ConcatDataset', function() {});
        this._registerConstructor('torch.utils.data.sampler.BatchSampler', function() {});
        this._registerConstructor('torch.utils.data.sampler.SequentialSampler', function() {});
        this._registerConstructor('torchvision.datasets.folder.ImageFolder', function() {});
        this._registerConstructor('torchvision.datasets.mnist.MNIST', function() {});
        this._registerConstructor('torchvision.datasets.vision.StandardTransform', function() {});
        this._registerConstructor('torchvision.models.alexnet.AlexNet', function() {});
        this._registerConstructor('torchvision.models.densenet.DenseNet', function() {});
        this._registerConstructor('torchvision.models.densenet._DenseBlock', function() {});
        this._registerConstructor('torchvision.models.densenet._DenseLayer', function() {});
        this._registerConstructor('torchvision.models.densenet._Transition', function() {});
        this._registerConstructor('torchvision.models.detection._utils.BalancedPositiveNegativeSampler', function() {});
        this._registerConstructor('torchvision.models.detection._utils.BoxCoder', function() {});
        this._registerConstructor('torchvision.models.detection._utils.Matcher', function() {});
        this._registerConstructor('torchvision.models.detection.backbone_utils.BackboneWithFPN', function() {});
        this._registerConstructor('torchvision.models.detection.faster_rcnn.FasterRCNN', function() {});
        this._registerConstructor('torchvision.models.detection.faster_rcnn.FastRCNNPredictor', function() {});
        this._registerConstructor('torchvision.models.detection.faster_rcnn.TwoMLPHead', function() {});
        this._registerConstructor('torchvision.models.detection.keypoint_rcnn.KeypointRCNN', function() {});
        this._registerConstructor('torchvision.models.detection.keypoint_rcnn.KeypointRCNNHeads', function() {});
        this._registerConstructor('torchvision.models.detection.keypoint_rcnn.KeypointRCNNPredictor', function() {});
        this._registerConstructor('torchvision.models.detection.mask_rcnn.MaskRCNN', function() {});
        this._registerConstructor('torchvision.models.detection.mask_rcnn.MaskRCNNHeads', function() {});
        this._registerConstructor('torchvision.models.detection.mask_rcnn.MaskRCNNPredictor', function() {});
        this._registerConstructor('torchvision.models.detection.roi_heads.RoIHeads', function() {});
        this._registerConstructor('torchvision.models.detection.rpn.AnchorGenerator', function() {});
        this._registerConstructor('torchvision.models.detection.rpn.RegionProposalNetwork', function() {});
        this._registerConstructor('torchvision.models.detection.rpn.RPNHead', function() {});
        this._registerConstructor('torchvision.models.detection.transform.GeneralizedRCNNTransform', function() {});
        this._registerConstructor('torchvision.models.googlenet.BasicConv2d', function() {});
        this._registerConstructor('torchvision.models.googlenet.GoogLeNet', function() {});
        this._registerConstructor('torchvision.models.googlenet.Inception', function() {});
        this._registerConstructor('torchvision.models.inception.BasicConv2d', function() {});
        this._registerConstructor('torchvision.models.inception.Inception3', function() {});
        this._registerConstructor('torchvision.models.inception.InceptionAux', function() {});
        this._registerConstructor('torchvision.models.inception.InceptionA', function() {});
        this._registerConstructor('torchvision.models.inception.InceptionB', function() {});
        this._registerConstructor('torchvision.models.inception.InceptionC', function() {});
        this._registerConstructor('torchvision.models.inception.InceptionD', function() {});
        this._registerConstructor('torchvision.models.inception.InceptionE', function() {});
        this._registerConstructor('torchvision.models.mobilenet.ConvBNReLU', function() {});
        this._registerConstructor('torchvision.models.mobilenet.MobileNetV2', function() {});
        this._registerConstructor('torchvision.models.mobilenet.InvertedResidual', function() {});
        this._registerConstructor('torchvision.models.resnet.Bottleneck', function() {});
        this._registerConstructor('torchvision.models.resnet.BasicBlock', function() {});
        this._registerConstructor('torchvision.models.quantization.resnet.QuantizableBottleneck', function() {});
        this._registerConstructor('torchvision.models.quantization.resnet.QuantizableResNet', function() {});
        this._registerConstructor('torchvision.models.segmentation.deeplabv3.ASPP', function() {});
        this._registerConstructor('torchvision.models.segmentation.deeplabv3.ASPPConv', function() {});
        this._registerConstructor('torchvision.models.segmentation.deeplabv3.ASPPPooling', function() {});
        this._registerConstructor('torchvision.models.segmentation.deeplabv3.DeepLabHead', function() {});
        this._registerConstructor('torchvision.models.segmentation.deeplabv3.DeepLabV3', function() {});
        this._registerConstructor('torchvision.models.segmentation.fcn.FCN', function() {});
        this._registerConstructor('torchvision.models.segmentation.fcn.FCNHead', function() {});
        this._registerConstructor('torchvision.models.shufflenetv2.ShuffleNetV2', function() {});
        this._registerConstructor('torchvision.models.shufflenetv2.InvertedResidual', function() {});
        this._registerConstructor('torchvision.models.squeezenet.Fire', function() {});
        this._registerConstructor('torchvision.models.squeezenet.SqueezeNet', function() {});
        this._registerConstructor('torchvision.models.resnet.ResNet', function() {});
        this._registerConstructor('torchvision.models.vgg.VGG', function() {});
        this._registerConstructor('torchvision.models.video.resnet.BasicBlock', function() {});
        this._registerConstructor('torchvision.models.video.resnet.BasicStem', function() {});
        this._registerConstructor('torchvision.models.video.resnet.Conv2Plus1D', function() {});
        this._registerConstructor('torchvision.models.video.resnet.Conv3DNoTemporal', function() {});
        this._registerConstructor('torchvision.models.video.resnet.Conv3DSimple', function() {});
        this._registerConstructor('torchvision.models.video.resnet.R2Plus1dStem', function() {});
        this._registerConstructor('torchvision.models.video.resnet.VideoResNet', function() {});
        this._registerConstructor('torchvision.models._utils.IntermediateLayerGetter', function() {});
        this._registerConstructor('torchvision.ops.deform_conv.DeformConv2d', function() {});
        this._registerConstructor('torchvision.ops.feature_pyramid_network.FeaturePyramidNetwork', function() {});
        this._registerConstructor('torchvision.ops.feature_pyramid_network.LastLevelMaxPool', function() {});
        this._registerConstructor('torchvision.ops.misc.ConvTranspose2d', function() {});
        this._registerConstructor('torchvision.ops.misc.FrozenBatchNorm2d', function() {});
        this._registerConstructor('torchvision.ops.poolers.LevelMapper', function() {});
        this._registerConstructor('torchvision.ops.poolers.MultiScaleRoIAlign', function() {});
        this._registerConstructor('torchvision.transforms.transforms.Compose', function() {});
        this._registerConstructor('torchvision.transforms.transforms.Normalize', function() {});
        this._registerConstructor('torchvision.transforms.transforms.Resize', function() {});
        this._registerConstructor('torchvision.transforms.transforms.ToPILImage', function() {});
        this._registerConstructor('torchvision.transforms.transforms.ToTensor', function() {});
        this._registerConstructor('torch.ByteStorage', function (size) {
            this.size = size; this.dataTypeSize = 1; this.dataType = 'uint8';
        });
        this._registerConstructor('torch.BoolStorage', function (size) {
            this.size = size; this.dataTypeSize = 1; this.dataType = 'boolean';
        });
        this._registerConstructor('torch.CharStorage', function (size) {
            this.size = size; this.dataTypeSize = 1; this.dataType = 'int8';
        });
        this._registerConstructor('torch.ShortStorage', function (size) {
            this.size = size; this.dataTypeSize = 2; this.dataType = 'int16';
        });
        this._registerConstructor('torch.IntStorage', function (size) {
            this.size = size; this.dataTypeSize = 4; this.dataType = 'int32';
        });
        this._registerConstructor('torch.LongStorage', function (size) {
            this.size = size; this.dataTypeSize = 8; this.dataType = 'int64';
        });
        this._registerConstructor('torch.HalfStorage', function (size) {
            this.size = size; this.dataTypeSize = 2; this.dataType = 'float16';
        });
        this._registerConstructor('torch.FloatStorage', function (size) {
            this.size = size; this.dataTypeSize = 4; this.dataType = 'float32';
        });
        this._registerConstructor('torch.DoubleStorage', function (size) {
            this.size = size; this.dataTypeSize = 8; this.dataType = 'float64';
        });
        this._registerConstructor('torch.QInt8Storage', function (size) {
            this.size = size; this.dataTypeSize = 1; this.dataType = 'qint8';
        });
        this._registerConstructor('torch.FloatTensor', function () {
            this.__setstate__ = function(state) {
                this.storage = state[0];
                this.storage_offset = state[1];
                this.size = state[2];
                this.stride = state[3];
            };
        });
        this._registerConstructor('torch.DoubleTensor', function () {
            this.__setstate__ = function(state) {
                this.storage = state[0];
                this.storage_offset = state[1];
                this.size = state[2];
                this.stride = state[3];
            };
        });
        this._registerConstructor('torch.cuda.FloatTensor', function () {
            this.__setstate__ = function(state) {
                this.storage = state[0];
                this.storage_offset = state[1];
                this.size = state[2];
                this.stride = state[3];
            };
        });
        this._registerConstructor('torch.cuda.DoubleTensor', function () {
            this.__setstate__ = function(state) {
                this.storage = state[0];
                this.storage_offset = state[1];
                this.size = state[2];
                this.stride = state[3];
            };
        });
        this._registerConstructor('numpy.core._multiarray_umath.scalar', function(dtype, rawData) {
            let data = rawData;
            if (typeof rawData === 'string') {
                data = new Uint8Array(rawData.length);
                for (let i = 0; i < rawData.length; i++) {
                    data[i] = rawData.charCodeAt(i);
                }
            }
            const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
            switch (dtype.name) {
                case 'uint8':
                    return dataView.getUint8(0);
                case 'float32':
                    return dataView.getFloat32(0, true);
                case 'float64':
                    return dataView.getFloat64(0, true);
                case 'int8':
                    return dataView.getInt8(0, true);
                case 'int16':
                    return dataView.getInt16(0, true);
                case 'int32':
                    return dataView.getInt32(0, true);
                case 'int64':
                    return dataView.getInt64(0, true);
            }
            throw new pytorch.Error("Unknown scalar type '" + dtype.name + "'.");
        });
        this._registerConstructor('numpy.core.multiarray._reconstruct', function(subtype, shape, dtype) {
            this.subtype = subtype;
            this.shape = shape;
            this.dtype = dtype;
            this.__setstate__ = function(state) {
                this.version = state[0];
                this.shape = state[1];
                this.typecode = state[2];
                this.is_f_order = state[3];
                this.rawdata = state[4];
            };
            this.__read__ = function(unpickler) {
                const array = {};
                const subtype = this.subtype.split('.');
                array.__name__ = subtype.pop();
                array.__module__ = subtype.join('.');
                array.dtype = this.typecode;
                array.shape = this.shape;
                let size = array.dtype.itemsize;
                for (let i = 0; i < array.shape.length; i++) {
                    size = size * array.shape[i];
                }
                if (typeof this.rawdata == 'string') {
                    array.data = unpickler.unescape(this.rawdata, size);
                    if (array.data.length != size) {
                        throw new pytorch.Error('Invalid string array data size.');
                    }
                }
                else {
                    array.data = this.rawdata;
                    if (array.data.length != size) {
                        // throw new pytorch.Error('Invalid array data size.');
                    }
                }
                return array;
            };
        });
        this._registerConstructor('numpy.dtype', function(obj, align, copy) {
            switch (obj) {
                case 'i1':  this.name = 'int8'; this.itemsize = 1; break;
                case 'i2':  this.name = 'int16'; this.itemsize = 2; break;
                case 'i4':  this.name = 'int32'; this.itemsize = 4; break;
                case 'i8':  this.name = 'int64'; this.itemsize = 8; break;
                case 'b1':  this.name = 'uint8'; this.itemsize = 1; break;
                case 'u1':  this.name = 'uint8'; this.itemsize = 1; break;
                case 'u2':  this.name = 'uint16'; this.itemsize = 2; break;
                case 'u4':  this.name = 'uint32'; this.itemsize = 4; break;
                case 'u8':  this.name = 'uint64'; this.itemsize = 8; break;
                case 'f4':  this.name = 'float32'; this.itemsize = 4; break;
                case 'f8':  this.name = 'float64'; this.itemsize = 8; break;
                case 'c8':  this.name = 'complex64'; this.itemsize = 8; break;
                case 'c16': this.name = 'complex128'; this.itemsize = 16; break;
                default:
                    if (obj.startsWith('V')) {
                        this.itemsize = Number(obj.substring(1));
                        this.name = 'void' + (this.itemsize * 8).toString();
                    }
                    else if (obj.startsWith('O')) {
                        this.itemsize = Number(obj.substring(1));
                        this.name = 'object';
                    }
                    else if (obj.startsWith('S')) {
                        this.itemsize = Number(obj.substring(1));
                        this.name = 'string';
                    }
                    else if (obj.startsWith('U')) {
                        this.itemsize = Number(obj.substring(1));
                        this.name = 'string';
                    }
                    else if (obj.startsWith('M')) {
                        this.itemsize = Number(obj.substring(1));
                        this.name = 'datetime';
                    }
                    else {
                        throw new pytorch.Error("Unknown dtype '" + obj.toString() + "'.");
                    }
                    break;
            }
            this.align = align;
            this.copy = copy;
            this.__setstate__ = function(state) {
                switch (state.length) {
                    case 8:
                        this.version = state[0];
                        this.byteorder = state[1];
                        this.subarray = state[2];
                        this.names = state[3];
                        this.fields = state[4];
                        this.elsize = state[5];
                        this.alignment = state[6];
                        this.int_dtypeflags = state[7];
                        break;
                    default:
                        throw new pytorch.Error("Unknown numpy.dtype setstate length '" + state.length.toString() + "'.");
                }
            };
        });
        this._registerFunction('__builtin__.bytearray', function(source, encoding /*, errors */) {
            if (source) {
                if (encoding === 'latin-1') {
                    const array = new Uint8Array(source.length);
                    for (let i = 0; i < source.length; i++) {
                        array[i] = source.charCodeAt(i);
                    }
                    return array;
                }
                throw new pytorch.Error("Unsupported bytearray encoding '" + JSON.stringify(encoding) + "'.");
            }
            return [];
        });
        this._registerFunction('__builtin__.bytes', function(source, encoding /*, errors */) {
            if (source) {
                if (encoding === 'latin-1') {
                    const array = new Uint8Array(source.length);
                    for (let i = 0; i < source.length; i++) {
                        array[i] = source.charCodeAt(i);
                    }
                    return array;
                }
                throw new pytorch.Error("Unsupported bytearray encoding '" + JSON.stringify(encoding) + "'.");
            }
            return [];
        });
        this._registerFunction('__builtin__.getattr', function(obj, name, defaultValue) {
            if (Object.prototype.hasOwnProperty.call(obj, name)) {
                return obj[name];
            }
            return defaultValue;
        });
        this._registerFunction('__builtin__.set', function(iterable) {
            return iterable ? iterable : [];
        });
        this._registerFunction('__builtin__.slice', function(start, stop , step) {
            return [ start, stop, step ];
        });
        this._registerFunction('collections.Counter', function(/* iterable */) {
            return {};
        });
        this._registerFunction('collections.OrderedDict', function(args) {
            const obj = new Map();
            obj.__setitem__ = function(key, value) {
                obj.set(key, value);
            };
            if (args) {
                for (const arg of args) {
                    obj.__setitem__(arg[0], arg[1]);
                }
            }
            return obj;
        });
        this._registerFunction('numpy.core.multiarray.scalar', function(dtype, rawData) {
            let data = rawData;
            if (rawData.constructor !== Uint8Array) {
                data = new Uint8Array(rawData.length);
                for (let i = 0; i < rawData.length; i++) {
                    data[i] = rawData.charCodeAt(i);
                }
            }
            const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
            switch (dtype.name) {
                case 'float32':
                    return dataView.getFloat32(0, true);
                case 'float64':
                    return dataView.getFloat64(0, true);
                case 'uint8':
                    return dataView.getUint8(0, true);
                case 'int8':
                    return dataView.getInt8(0, true);
                case 'int16':
                    return dataView.getInt16(0, true);
                case 'int32':
                    return dataView.getInt32(0, true);
                case 'int64':
                    return dataView.getInt64(0, true);
            }
            throw new pytorch.Error("Unknown scalar type '" + dtype.name + "'.");
        });
        this._registerFunction('_codecs.encode', function(obj /*, econding */) {
            return obj;
        });
        this._registerFunction('collections.defaultdict', function(/* default_factory */) {
            return {};
        });
        this._registerFunction('annotate', function(type, value) {
            return value;
        });
        this._registerFunction('int', function(/* tensor */) {
            return NaN; // TODO
        });
        this._registerFunction('float', function(/* tensor */) {
            return NaN; // TODO
        });
        this._registerFunction('getattr', function(obj, name, defaultValue) {
            if (Object.prototype.hasOwnProperty.call(obj, name)) {
                return obj[name];
            }
            return defaultValue;
        });
        this._registerFunction('unchecked_cast', function(type, value) {
            return value;
        });
        this._registerFunction('ops.prim.data', function(tensor) {
            return tensor;
        });
        this._registerFunction('ops.prim.unchecked_unwrap_optional', function(value) {
            return value;
        });
        this._registerFunction('ops.prim.NumToTensor', function(value) {
            return { __module__: 'torch', __name__: 'Tensor', value: value }; // TODO
        });
        this._registerFunction('ops.prim.min', function(value) {
            return Math.min.apply(null, value);
        });
        this._registerFunction('ops.prim.shape', function(value) {
            return value.size;
        });
        this._registerFunction('ops.quantized.conv_prepack', function(weight, bias, stride, padding, dilation, groups) {
            return {
                __module__: '__torch__.torch.classes.quantized',
                __name__: 'Conv2dPackedParamsBase',
                weight: weight,
                bias: bias,
                stride: stride,
                padding: padding,
                dilation: dilation,
                groups: groups
            };
        });
        this._registerFunction('ops.quantized.conv1d_prepack', function(weight, bias, stride, padding, dilation, groups) {
            return {
                __module__: '__torch__.torch.classes.quantized',
                __name__: 'Conv2dPackedParamsBase',
                weight: weight,
                bias: bias,
                stride: stride,
                padding: padding,
                dilation: dilation,
                groups: groups
            };
        });
        this._registerFunction('ops.quantized.conv2d_prepack', function(weight, bias, stride, padding, dilation, groups) {
            return {
                __module__: '__torch__.torch.classes.quantized',
                __name__: 'Conv2dPackedParamsBase',
                weight: weight,
                bias: bias,
                stride: stride,
                padding: padding,
                dilation: dilation,
                groups: groups
            };
        });
        this._registerFunction('ops.quantized.conv_transpose2d_prepack', function(weight, bias, stride, padding, dilation, groups) {
            return {
                __module__: '__torch__.torch.classes.quantized',
                __name__: 'Conv2dPackedParamsBase',
                weight: weight,
                bias: bias,
                stride: stride,
                padding: padding,
                dilation: dilation,
                groups: groups
            };
        });
        this._registerFunction('ops.quantized.linear_prepack', function(weight, bias) {
            return {
                __module__: '__torch__.torch.classes.quantized',
                __name__: 'LinearPackedParamsBase',
                weight: weight,
                bias: bias
            };
        });
        this._registerFunction('ops.prim.RaiseException', function(message) {
            throw new pytorch.Error(message);
        });
        this._registerFunction('range', function(start, stop, step) {
            if (start !== undefined && Number.isInteger(start) && stop === undefined && step === undefined) {
                return Array(start).keys();
            }
            throw new pytorch.Error('Unsupported function range(' + JSON.stringify(start) + ', ' + JSON.stringify(stop) + ', ' + JSON.stringify(step) + ')');
        });
        this._registerFunction('torch._utils._rebuild_tensor', function (storage, storage_offset, size, stride) {
            return {
                __module__: storage.__module__,
                __name__: storage.__name__.replace('Storage', 'Tensor'),
                storage: storage,
                storage_offset: storage_offset,
                size: size,
                stride: stride
            };
        });
        this._registerFunction('torch._utils._rebuild_tensor_v2', function (storage, storage_offset, size, stride, requires_grad, backward_hooks) {
            return {
                __module__: storage.__module__,
                __name__: storage.__name__.replace('Storage', 'Tensor'),
                storage: storage,
                storage_offset: storage_offset,
                size: size,
                stride: stride,
                requires_grad: requires_grad,
                backward_hooks: backward_hooks
            };
        });
        this._registerFunction('torch._utils._rebuild_parameter', function(data, requires_grad, backward_hooks) {
            const obj = self.invoke('torch.nn.parameter.Parameter', [ data, requires_grad ]);
            obj.backward_hooks = backward_hooks;
            return obj;
        });
        this._registerFunction('torch._utils._rebuild_qtensor', function(storage, storage_offset, size, stride, quantizer_params, requires_grad, backward_hooks) {
            return {
                __module__: storage.__module__,
                __name__: storage.__name__.replace('Storage', 'Tensor'),
                storage: storage,
                storage_offset: storage_offset,
                size: size,
                stride: stride,
                quantizer_params: quantizer_params,
                requires_grad:requires_grad,
                backward_hooks: backward_hooks
            };
        });
        this._registerFunction('torch._set_item', function(dict, key, value) {
            dict[key] = value;
        });
        this._registerFunction('torch.__contains__', function(dict, key) {
            return dict[key] !== undefined;
        });
        this._registerFunction('torch.__derive_index', function(index, start, step) {
            return start + index * step;
        });
        this._registerFunction('torch.__is__', function(left, right) {
            if (left === null && right === null) {
                return true;
            }
            if ((left !== null && right === null) || (left === null && right !== null)) {
                return false;
            }
            throw new pytorch.Error("Unknown 'torch.__is__' expression type.");
        });
        this._registerFunction('torch.__isnot__', function(left, right) {
            if (left === null && right === null) {
                return false;
            }
            if ((left !== null && right === null) || (left === null && right !== null)) {
                return true;
            }
            throw new pytorch.Error("Unknown 'torch.__isnot__' expression type.");
        });
        this._registerFunction('torch.__not__', function(value) {
            if (typeof value === 'boolean') {
                return !value;
            }
            throw new pytorch.Error("Unknown 'torch.__not__' expression type.");
        });
        this._registerFunction('torch.__range_length', function(lo, hi, step) {
            if (step === 0) {
                throw new pytorch.Error('range() arg 3 must not be zero');
            }
            if (step > 0 && lo < hi) {
                return 1 + (hi - 1 - lo) / step;
            }
            else if (step < 0 && lo > hi) {
                return 1 + (lo - 1 - hi) / (0 - step);
            }
            return 0;
        });
        this._registerFunction('torch._unwrap_optional', function(value) {
            return value; // TODO
        });
        this._registerFunction('torch.add', function(left, right) {
            if (typeof left === 'number' && typeof right === 'number') {
                return left * right;
            }
            throw new pytorch.Error('Unknown torch.add expression type.');
        });
        this._registerFunction('torch.append', function(tensors, tensor) {
            tensors.push(tensor);
            return tensor;
        });
        this._registerFunction('torch.dict', function(args) {
            if (args) {
                throw new pytorch.Error("'torch.dict' arguments not supported.");
            }
            return {};
        });
        this._registerFunction('torch.dim', function(tensor) {
            if (tensor && tensor.size) {
                return tensor.size.length;
            }
            return 0; // TODO
        });
        this._registerFunction('torch.eq', function(left, right) {
            if (typeof left === 'string' && typeof right === 'string') {
                return left === right;
            }
            if (typeof left === 'number' && typeof right === 'number') {
                return left === right;
            }
            throw new pytorch.Error("Unknown 'torch.eq' expression type.");
        });
        this._registerFunction('torch.floordiv', function(/* left, right */) {
            return undefined;
        });
        this._registerFunction('torch.gt', function(left, right) {
            if (typeof left === 'number' && typeof right === 'number') {
                if (!isNaN(left) && !isNaN(right)) {
                    return left > right;
                }
            }
            if (isNaN(left) && !isNaN(right)) {
                return true;
            }
            throw new pytorch.Error("Unknown 'torch.gt' expression type.");
        });
        this._registerFunction('torch.ge', function(left, right) {
            if (typeof left === 'number' && typeof right === 'number') {
                if (!isNaN(left) && !isNaN(right)) {
                    return left > right;
                }
            }
            if (isNaN(left) && !isNaN(right)) {
                return true;
            }
            throw new pytorch.Error("Unknown 'torch.ge' expression type.");
        });
        this._registerFunction('torch.jit._pickle.build_boollist', function(data) {
            return data;
        });
        this._registerFunction('torch.jit._pickle.build_doublelist', function(data) {
            return data;
        });
        this._registerFunction('torch.jit._pickle.build_intlist', function(data) {
            return data;
        });
        this._registerFunction('torch.jit._pickle.build_tensorlist', function(data) {
            return data;
        });
        this._registerFunction('torch.jit._pickle.build_tensor_from_id', function(data) {
            const constants = self.context.getx('CONSTANTS');
            return constants['c' + data.toString()];
        });
        this._registerFunction('torch.jit._pickle.restore_type_tag', function(value /*, type_str */) {
            return value;
        });
        this._registerFunction('torch.keys', function(dict) {
            return Object.keys(dict);
        });
        this._registerFunction('torch.len', function(value) {
            if (value) {
                return value.length;
            }
            return NaN;
        });
        this._registerFunction('torch.le', function(left, right) {
            if (typeof left === 'number' && typeof right === 'number') {
                if (isNaN(left) || isNaN(right)) {
                    return false;
                }
                return left <= right;
            }
            throw new pytorch.Error("Unknown 'torch.le' expression type.");
        });
        this._registerFunction('torch.list', function(args) {
            return args;
        });
        this._registerFunction('torch.list_with_default', function(size /*, defaults */) {
            return size;
        });
        this._registerFunction('torch.lt', function(left, right) {
            if (typeof left === 'number' && typeof right === 'number') {
                return left < right;
            }
            throw new pytorch.Error("Unknown 'torch.lt' expression type.");
        });
        this._registerFunction('torch.mul', function(left, right) {
            if (typeof left === 'number' && typeof right === 'number') {
                return left * right;
            }
            if (isNaN(left) || isNaN(right)) {
                return NaN;
            }
            throw new pytorch.Error("Unknown 'torch.mul' expression type.");
        });
        this._registerFunction('torch.ne', function(left, right) {
            if (typeof left === 'number' && typeof right === 'number') {
                if (isNaN(left) || isNaN(right)) {
                    return false;
                }
                return left !== right;
            }
            if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) {
                return false;
            }
            throw new pytorch.Error("Unknown 'torch.ne' expression type.");
        });
        this._registerFunction('torch.neg', function(value) {
            if (typeof value === 'number') {
                return -value;
            }
            throw new pytorch.Error("Unknown 'torch.neg' expression type.");
        });
        this._registerFunction('torch.q_scale', function(/* tensor */) {
            return -1; // TODO
        });
        this._registerFunction('torch.t', function(tensor) {
            return tensor;
        });
        this._registerFunction('torch.size', function(tensor, dim) {
            if (tensor && Array.isArray(tensor.size)) {
                if (dim === undefined) {
                    return tensor.size;
                }
                if (Number.isInteger(dim)) {
                    if (dim >= 0 && dim < tensor.size.length) {
                        return tensor.size[dim];
                    }
                    if (dim < 0 && -dim < tensor.size.length) {
                        return tensor.size[tensor.size.length + dim];
                    }
                }
                throw new pytorch.Error('Dimension out of range (expected to be in range of ' + JSON.stringify(tensor.size) + ', but got ' + JSON.stringify(dim) + ').');
            }
            return NaN;
        });
        this._registerFunction('torch.slice', function(l, start, end, step) {
            if (step !== 1) {
                throw new pytorch.Error('Slicing only supports step=1');
            }
            start = Math.max(0, start);
            end = Math.min(l.length, end);
            return l.slice(start, end);
        });
        this._registerFunction('torch.sub', function(left, right) {
            if (typeof left === 'number' && typeof right === 'number') {
                return left * right;
            }
            throw new pytorch.Error("Unknown 'torch.sub' expression type.");
        });
        this._registerFunction('torch.values', function(dict) {
            return Object.keys(dict).map((key) => dict[key]);
        });
        this._registerFunction('torch.warn', function() {
        });
        this._registerFunction('uninitialized', function(/* type */) {
            return undefined;
        });
    }

    get context() {
        return this._context;
    }

    parse(file) {
        if (this._sources.has(file)) {
            const buffer = this._sources.get(file);
            const code = this._utf8Decoder.decode(buffer);
            const reader = new this._python.Parser(code, file);
            const program = reader.parse();
            if (!program) {
                throw new pytorch.Error("Module '" + file + "' parse error.");
            }
            return program;
        }
        return null;
    }

    package(name, file, raw) {
        if (this._python && !this._packages.has(name)) {
            file = file || 'code/' + name.split('.').join('/') + '.py';
            const program = this.parse(file);
            if (program) {
                let globals = this._context.getx(name);
                if (globals === undefined) {
                    globals = {};
                    this._context.setx(name, globals);
                }
                globals.__class__ = this._context.scope.builtins.module;
                globals.__name__ = name;
                globals.__file__ = file;
                this._packages.set(name, globals);
                const context = this._context.push(globals);
                this._block(program.body, context);
                if (raw) {
                    return program;
                }
            }
        }
        return this._packages.get(name);
    }

    type(name) {
        const type = this._context.getx(name);
        if (type !== undefined) {
            return type;
        }
        const parts = name.split('.');
        const className = parts.pop();
        const moduleName = parts.join('.');
        const module = this.package(moduleName);
        if (module) {
            return module[className];
        }
        return null;
    }

    invoke(name, args) {
        const target = this.type(name);
        if (target) {
            if (target.__class__ === this._context.scope.builtins.type) {
                const obj = {};
                obj.__proto__ = target;
                if (obj.__init__ && typeof obj.__init__ === 'function') {
                    obj.__init__.apply(obj, args);
                }
                return obj;
            }
            else if (target.__class__ === this._context.scope.builtins.function) {
                if (target.__call__) {
                    return target.__call__(args);
                    // throw new pytorch.Error('Unexpected function __call__.');
                }
                else {
                    return target.apply(null, args);
                }
            }
        }
        this._raiseUnkownName(name);
        const typeParts = name.split('.');
        const typeName = typeParts.pop();
        const typeModule = typeParts.join('.');
        return {
            __module__: typeModule,
            __name__: typeName
        };
    }

    call(target, name, args, context) {
        const callTarget = this._target(target, context);
        const callArguments = args.map((argument) => this.expression(argument, context));
        if (!callTarget || (name !== null && !callTarget[name])) {
            if (name === '__new__' && callArguments.length === 1 && callArguments[0] == callTarget) {
                name = null;
                callArguments.shift();
            }
            else {
                const targetName = pytorch.Utility.target(target) + '.' + name;
                if (this.type(targetName)) {
                    return this.invoke(targetName, callArguments);
                }
                throw new pytorch.Error("Unsupported function '" +  targetName + "'.");
            }
        }
        const func = name ? callTarget[name] : callTarget;
        if (func.__class__ === this._context.scope.builtins.type) {
            const obj = {};
            obj.__proto__ = func;
            if (obj.__init__ && typeof obj.__init__ === 'function') {
                obj.__init__.apply(obj, args);
            }
            return obj;
        }
        if (func.__class__ === this._context.scope.builtins.function) {
            if (func.__call__) {
                return func.__call__(callArguments);
            }
        }
        if (func.__class__ === this._context.scope.builtins.method) {
            if (func.__call__) {
                return func.__call__([ callTarget ].concat(callArguments));
            }
        }
        if (typeof func === 'function') {
            return func.apply(callTarget, callArguments);
        }
        throw new pytorch.Error("Unsupported call expression.");
    }

    apply(method, args, context) {
        const locals = Array.prototype.slice.call(args);
        context = context.push();
        for (const parameter of method.parameters) {
            context.set(parameter.name, locals.shift());
        }
        return this._block(method.body.statements, context);
    }

    _block(statements, context) {
        statements = Array.prototype.slice.call(statements);
        while (statements.length > 0) {
            const statement = statements.shift();
            switch (statement.type) {
                case 'pass': {
                    break;
                }
                case 'return': {
                    return this.expression(statement.expression, context);
                }
                case 'def': {
                    const module = context.get('__name__');
                    const self = this;
                    const parent = context.get('__class__');
                    let type = null;
                    if (parent === this._context.scope.builtins.type) {
                        type = this._context.scope.builtins.method;
                    }
                    else if (parent === this._context.scope.builtins.module) {
                        type = this._context.scope.builtins.function;
                    }
                    else {
                        throw new pytorch.Error('Invalid function scope.');
                    }
                    const func = {
                        __class__: type,
                        __globals__: context,
                        __module__: module,
                        __name__: statement.name,
                        __code__: statement,
                        __call__: function(args) {
                            return self.apply(this.__code__, args, this.__globals__);
                        }
                    };
                    context.set(statement.name, func);
                    break;
                }
                case 'class': {
                    const scope = {
                        __class__:this._context.scope.builtins.type,
                        __module__: context.get('__name__'),
                        __name__: statement.name,
                    };
                    context.set(statement.name, scope);
                    context = context.push(scope);
                    this._block(statement.body.statements, context);
                    context = context.pop();
                    break;
                }
                case 'var': {
                    context.set(statement.name, undefined);
                    break;
                }
                case '=': {
                    this.expression(statement, context);
                    break;
                }
                case 'if': {
                    const condition = this.expression(statement.condition, context);
                    if (condition === true || condition) {
                        statements = statement.then.statements.concat(statements);
                        break;
                    }
                    else if (condition === false) {
                        statements = statement.else.statements.concat(statements);
                        break;
                    }
                    throw new pytorch.Error("Unknown condition.");
                }
                case 'for': {
                    if (statement.target.length == 1 &&
                        statement.variable.length === 1 && statement.variable[0].type === 'id') {
                        const range = this.expression(statement.target[0], context);
                        const variable = statement.variable[0];
                        const loop = [];
                        for (const value of range) {
                            loop.push({ type: '=', target: variable, expression: { type: 'number', value: value }});
                            loop.push(...statement.body.statements);
                        }
                        statements = loop.concat(statements);
                        break;
                    }
                    throw new pytorch.Error("Unsupported 'for' statement.");
                }
                case 'while': {
                    const condition = this.expression(statement.condition, context);
                    if (condition) {
                        throw new pytorch.Error("Unsupported 'while' statement.");
                    }
                    break;
                }
                case 'call': {
                    this.expression(statement, context);
                    break;
                }
                case 'import': {
                    for (const module of statement.modules) {
                        const moduleName = pytorch.Utility.target(module.name);
                        const globals = this.package(moduleName);
                        if (module.as) {
                            context.set(module.as, globals);
                        }
                    }
                    break;
                }
                default: {
                    throw new pytorch.Error("Unknown statement '" + statement.type + "'.");
                }
            }
        }
    }

    expression(expression, context) {
        const self = context.getx('self');
        switch (expression.type) {
            case '=': {
                const target = expression.target;
                if (target.type === 'id') {
                    context.set(target.value, this.expression(expression.expression, context));
                    return;
                }
                else if (target.type === '[]') {
                    if (target.target.type === 'id' &&
                        target.arguments.type === 'list' &&
                        target.arguments.value.length === 1) {
                        const index = this.expression(target.arguments.value[0], context);
                        if (target.target.value === '__annotations__') {
                            context.set(target.target.value, context.get(target.target.value) || {});
                        }
                        context.get(target.target.value)[index] = this.expression(expression.expression, context);
                        return;
                    }
                }
                else if (target.type === '.' &&
                    target.member.type === 'id') {
                    this.expression(target.target, context)[target.member.value] = this.expression(expression.expression, context);
                    return;
                }
                else if (target.type === 'tuple') {
                    const value = this.expression(expression.expression, context);
                    if  (target.value.length == value.length && target.value.every((item) => item.type === 'id')) {
                        for (let i = 0; i < value.length; i++) {
                            context.set(target.value[i].value, value[i]);
                        }
                        return;
                    }
                }
                break;
            }
            case 'list': {
                return expression.value.map((item) => this.expression(item, context));
            }
            case 'string': {
                return expression.value.substring(1, expression.value.length - 1);
            }
            case 'number': {
                return Number(expression.value);
            }
            case '[]': {
                if (expression.target.type === 'id' &&
                    expression.arguments.type === 'list' &&
                    expression.arguments.value.length === 1) {
                    if (context.get(expression.target.value)) {
                        const index = this.expression(expression.arguments.value[0], context);
                        return context.get(expression.target.value)[index];
                    }
                }
                const target = this.expression(expression.target, context);
                if (target && expression.arguments.type === 'list' &&
                    (target.__class__ === this.context.scope.typing._VariadicGenericAlias ||
                     target.__class__ === this.context.scope.typing._GenericAlias ||
                     target.__class__ === this.context.scope.typing._SpecialForm)) {
                    const type = Object.assign({}, target);
                    type.__args__ = expression.arguments.value.map((arg) => this.expression(arg, context));
                    return type;
                }
                if (expression.arguments.type === 'list' && expression.arguments.value.length === 1) {
                    const index = this.expression(expression.arguments.value[0], context);
                    return target[index];
                }
                break;
            }
            case '.': {
                if (expression.member.type == 'id') {
                    const target = this._target(expression.target, context);
                    return target[expression.member.value];
                }
                throw new pytorch.Error("Unsupported field expression.");
            }
            case 'call': {
                if (expression.target.type === 'id' && expression.target.value === 'annotate' && expression.arguments.length === 2) {
                    return this.expression(expression.arguments[1], context);
                }
                if (expression.target.type === 'id' && expression.target.value === 'unchecked_cast' && expression.arguments.length === 2) {
                    return this.expression(expression.arguments[1], context);
                }
                if (expression.target.type === '.') {
                    return this.call(expression.target.target, expression.target.member.value, expression.arguments, context);
                }
                return this.call(expression.target, null, expression.arguments, context);
            }
            case 'id': {
                switch (expression.value) {
                    case 'self': return self;
                    case 'None': return null;
                    case 'True': return true;
                    case 'False': return false;
                }
                const type =
                    this._context.scope.builtins[expression.value] ||
                    this._context.scope.typing[expression.value] ||
                    this._context.scope.torch[expression.value];
                if (type &&
                    (type.__class__ === this._context.scope.builtins.type ||
                     type.__class__ === this._context.scope.typing._VariadicGenericAlias ||
                     type.__class__ === this._context.scope.typing._GenericAlias ||
                     type.__class__ === this._context.scope.typing._SpecialForm)) {
                    return type;
                }
                return context.get(expression.value);
            }
            case 'tuple': {
                return expression.value.map((expression) => this.expression(expression, context));
            }
        }
        throw new pytorch.Error("Unknown expression '" + expression.type + "'.");
    }

    _target(expression, context) {
        let current = expression;
        let packageName = '';
        for (;;) {
            if (current.type === '.' && current.member && current.member.type === 'id') {
                packageName = '.' + current.member.value + packageName;
                current = current.target;
            }
            else if (current.type === 'id' && current.value !== 'self' && current.value !== 'CONSTANTS') {
                packageName = current.value + packageName;
                break;
            }
            else {
                packageName = null;
                break;
            }
        }
        if (packageName) {
            let target = context.getx(packageName);
            if (!target) {
                target = this.package(packageName);
                if (!target) {
                    throw new pytorch.Error("Failed to resolve module '" + packageName + "'.");
                }
            }
            return target;
        }
        return this.expression(expression, context);
    }

    _registerFunction(name, callback) {
        if (this._context.getx(name)) {
            throw new pytorch.Error("Function '" + name + "' is already registered.");
        }
        const parts = name.split('.');
        callback.__class__ = this._context.scope.builtins.function;
        callback.__name__ = parts.pop();
        callback.__module__ = parts.join('.');
        this._context.setx(name, callback);
    }

    _registerConstructor(name, callback) {
        if (this._context.getx(name)) {
            throw new pytorch.Error("Constructor '" + name + "' is already registered.");
        }
        const parts = name.split('.');
        const typeName = parts.pop();
        const typeModule = parts.join('.');
        const type = {
            __class__: this._context.scope.builtins.type,
            __name__: typeName,
            __module__: typeModule,
            __init__: function() {
                callback.apply(this, arguments);
            }
        };
        this._context.setx(name, type);
    }

    _raiseUnkownName(name) {
        if (name && !this._unknownNameMap.has(name)) {
            this._unknownNameMap.add(name);
            if (this._knownPackageMap.has(name.split('.').shift())) {
                this._exceptionCallback(new pytorch.Error("Unknown function '" + name + "'."), false);
            }
        }
    }
};

pytorch.Execution.Context = class {

    constructor(parent, scope) {
        this._parent = parent || null;
        this._scope = scope || {};
    }

    push(scope) {
        return new pytorch.Execution.Context(this, scope);
    }

    pop() {
        return this._parent;
    }

    get scope() {
        return this._scope;
    }

    set(name, value) {
        this._scope[name] = value;
    }

    get(name) {
        if (name in this._scope) {
            return this._scope[name];
        }
        if (this._parent) {
            return this._parent.get(name);
        }
        return undefined;
    }

    setx(name, value) {
        const parts = name.split('.');
        if (parts.length == 1) {
            this.set(parts[0], value);
        }
        else {
            let parent = this.get(parts[0]);
            if (!parent) {
                parent = {};
                this.set(parts[0], parent);
            }
            parts.shift();
            while (parts.length > 1) {
                const part = parts.shift();
                parent[part] = parent[part] || {};
                parent = parent[part];
            }
            parent[parts[0]] = value;
        }
    }

    getx(name) {
        const parts = name.split('.');
        let value = this.get(parts[0]);
        if (value) {
            parts.shift();
            while (parts.length > 0 && value[parts[0]]) {
                value = value[parts[0]];
                parts.shift();
            }
            if (parts.length === 0) {
                return value;
            }
        }
        return undefined;
    }
};

pytorch.Container = class {

    static open(context, metadata, pickle, python, exception) {
        if (context.entries('zip').some((entry) => entry.name === 'model.json' || entry.name === 'data.pkl' || entry.name.endsWith('/model.json') || entry.name.endsWith('/data.pkl'))) {
            return new pytorch.Container.Zip(context.entries('zip'), metadata, pickle, python, exception);
        }
        const buffer = context.buffer;
        const signature = [ 0x8a, 0x0a, 0x6c, 0xfc, 0x9c, 0x46, 0xf9, 0x20, 0x6a, 0xa8, 0x50, 0x19 ];
        if (buffer && buffer.length > 14 && buffer[0] == 0x80 && buffer[1] < 0x10 && signature.every((v, i) => v == buffer[i + 2])) {
            return new pytorch.Container.Pickle(buffer, pickle, exception);
        }
        if (context.entries('tar').some((entry) => entry.name == 'pickle')) {
            return new pytorch.Container.Tar(context.entries('tar'), pickle, exception);
        }
        return null;
    }
};

pytorch.Container.Tar = class {

    constructor(entries, pickle, exceptionCallback) {
        this._entries = entries;
        this._pickle = pickle;
        this._exceptionCallack = exceptionCallback;
    }

    get format() {
        return 'PyTorch v0.1.1';
    }

    get type() {
        this._unpickle();
        return this._type;
    }

    get data() {
        this._unpickle();
        return this._data;
    }

    get littleEndian() {
        this._unpickle();
        return this._littleEndian;
    }

    _unpickle() {
        if (!this._entries) {
            return;
        }
        this._type = '';
        this._data = null;
        this._littleEndian = true;

        const execution = new pytorch.Execution(null, null, this._exceptionCallback);

        const entries = {};
        for (const entry of this._entries) {
            switch (entry.name) {
                case 'sys_info': entries.sys_info = entry.data; break;
                case 'pickle': entries.pickle = entry.data; break;
                case 'storages': entries.storages = entry.data; break;
                case 'tensors': entries.tensors = entry.data; break;
            }
        }

        this._exceptionCallback = null;
        this._entries = null;

        if (entries.sys_info) {
            const unpickler = new this._pickle.Unpickler(entries.sys_info);
            const sys_info = unpickler.load((name, args) => execution.invoke(name, args));
            if (sys_info.protocol_version != 1000) {
                throw new pytorch.Error("Unsupported protocol version '" + sys_info.protocol_version + "'.");
            }
            if (sys_info.type_sizes &&
                ((sys_info.type_sizes.int && sys_info.type_sizes.int != 4) ||
                (sys_info.type_sizes.long && sys_info.type_sizes.long != 4) ||
                (sys_info.type_sizes.short && sys_info.type_sizes.short != 2))) {
                throw new pytorch.Error('Unsupported type sizes.');
            }
            this._littleEndian = sys_info.little_endian;
        }

        const deserialized_objects = {};
        if (entries.storages) {
            const unpickler = new this._pickle.Unpickler(entries.storages);
            const num_storages = unpickler.load((name, args) => execution.invoke(name, args));
            for (let i = 0; i < num_storages; i++) {
                const storage_args = unpickler.load();
                const storage_key = storage_args[0];
                const storage_type = storage_args[2];
                const size = pytorch.Utility.readInt64(unpickler.read(8));
                const storage = execution.invoke(storage_type, [ size ]);
                storage.data = unpickler.read(storage.dataTypeSize * storage.size);
                deserialized_objects[storage_key] = storage;
            }
            /*
            let storage_views = unpickler.load();
            for target_cdata, root_cdata, offset, size in storage_views:
                root = deserialized_objects[root_cdata]
                deserialized_objects[target_cdata] = root[offset:offset + size]
            */
        }

        if (entries.tensors) {
            const unpickler = new this._pickle.Unpickler(entries.tensors);
            const num_tensors = unpickler.load((name, args) => execution.invoke(name, args));
            for (let j = 0; j < num_tensors; j++) {
                const tensor_args = unpickler.load();
                const tensor_key = tensor_args[0];
                const storage_id = tensor_args[1];
                const storage = deserialized_objects[storage_id];
                const ndim = pytorch.Utility.readInt32(unpickler.read(4));
                unpickler.read(4);
                const shape = [];
                for (let k = 0; k < ndim; k++) {
                    shape.push(pytorch.Utility.readInt64(unpickler.read(8)));
                }
                const stride = [];
                for (let l = 0; l < ndim; l++) {
                    stride.push(pytorch.Utility.readInt64(unpickler.read(8)));
                }
                const storage_offset = pytorch.Utility.readInt64(unpickler.read(8));
                const tensor_type_name = storage.__name__.replace('Storage', 'Tensor');
                const tensor = execution.invoke(storage.__module__ + '.' + tensor_type_name, []);
                tensor.__setstate__([ storage, storage_offset, shape, stride ]);
                deserialized_objects[tensor_key] = tensor;
            }
        }

        if (entries.pickle) {
            const unpickler = new this._pickle.Unpickler(entries.pickle);
            const persistent_load = (saved_id) => {
                return deserialized_objects[saved_id];
            };
            const obj = unpickler.load((name, args) => execution.invoke(name, args), persistent_load);
            const weights = pytorch.Utility.findWeights(obj);
            if (weights) {
                this._type = 'weights';
                this._data = weights;
            }
            else {
                throw new pytorch.Error('File does not contain root module or state dictionary.');
            }
        }
    }
};

pytorch.Container.Pickle = class {

    constructor(buffer, pickle, exception) {
        this._buffer = buffer;
        this._pickle = pickle;
        this._exceptionCallback = exception;
    }

    get format() {
        return 'PyTorch v0.1.10';
    }

    get type() {
        this._unpickle();
        return this._type;
    }

    get data() {
        this._unpickle();
        return this._data;
    }

    get littleEndian() {
        this._unpickle();
        return this._littleEndian;
    }

    _unpickle() {
        if (!this._buffer) {
            return;
        }

        const execution = new pytorch.Execution(null, null, this._exceptionCallback);
        const unpickler = new this._pickle.Unpickler(this._buffer);

        this._buffer = null;
        this._pickle = null;
        this._exceptionCallback = null;

        unpickler.load(); // magic_number
        const protocol_version = unpickler.load();
        if (protocol_version != 1001) {
            throw new pytorch.Error("Unsupported protocol version '" + protocol_version + "'.");
        }
        const sys_info = unpickler.load();
        if (sys_info.protocol_version != 1001) {
            throw new pytorch.Error("Unsupported protocol version '" + sys_info.protocol_version + "'.");
        }
        if (sys_info.type_sizes &&
            ((sys_info.type_sizes.int && sys_info.type_sizes.int != 4) ||
            (sys_info.type_sizes.long && sys_info.type_sizes.long != 4) ||
            (sys_info.type_sizes.short && sys_info.type_sizes.short != 2))) {
            throw new pytorch.Error('Unsupported type sizes.');
        }
        this._littleEndian = sys_info.little_endian;

        const module_source_map = new Map();
        const deserialized_objects = new Map();
        const persistent_load = (saved_id) => {
            const typename = saved_id.shift();
            const data = saved_id;
            switch (typename) {
                case 'module': {
                    const module = data[0];
                    const source = data[2];
                    module_source_map.set(module, source);
                    return data[0];
                }
                case 'storage': {
                    const data_type = data.shift();
                    const root_key = data.shift();
                    data.shift(); // location
                    const size = data.shift();
                    const view_metadata = data.shift();
                    if (!deserialized_objects.has(root_key)) {
                        const storage = execution.invoke(data_type, [ size ]);
                        deserialized_objects.set(root_key, storage);
                    }
                    if (view_metadata) {
                        const view_key = view_metadata.shift();
                        view_metadata.shift(); // view_offset
                        view_metadata.shift(); // view_size
                        if (!deserialized_objects.has(view_key)) {
                            const view = null; // storage.slice(view_offset, view_offset + view_size);
                            deserialized_objects.set(view_key, view);
                        }
                        return deserialized_objects.get(view_key);
                    }
                    return deserialized_objects.get(root_key);
                }
            }
            throw new pytorch.Error("Unknown persistent load type '" + typename + "'.");
        };

        const obj = unpickler.load((name, args) => execution.invoke(name, args), persistent_load);
        if (!obj) {
            throw new pytorch.Error('File format is not PyTorch.');
        }
        if (obj === 'None') {
            throw new pytorch.Error("File contains 'None' root object.");
        }

        const deserialized_storage_keys = unpickler.load();
        for (const deserialized_storage_key of deserialized_storage_keys) {
            const storage = deserialized_objects.get(deserialized_storage_key);
            const size = pytorch.Utility.readInt64(unpickler.read(8));
            if (size != storage.size) {
                throw new pytorch.Error('Storage size mismatch.');
            }
            storage.data = unpickler.read(storage.dataTypeSize * storage.size);
        }

        const root = pytorch.Utility.findModule(obj);
        if (root) {
            this._type = 'module';
            this._data = root;
        }
        else {
            const weights = pytorch.Utility.findWeights(obj);
            if (weights) {
                this._type = 'weights';
                this._data = weights;
            }
            else {
                throw new pytorch.Error('File does not contain root module or state dictionary.');
            }
        }
    }
};

pytorch.Container.Zip = class {

    constructor(entries, metadata, pickle, python, exceptionCallback) {
        this._entries = entries;
        this._metadata = metadata;
        this._pickle = pickle;
        this._python = python;
        this._exceptionCallback = exceptionCallback;
        // https://github.com/pytorch/pytorch/blob/master/torch/csrc/jit/docs/serialization.md
        const entry = this._entries.find((entry) => entry.name == 'model.json' || entry.name == 'data.pkl' || entry.name.endsWith('/model.json') || entry.name.endsWith('/data.pkl'));
        if (!entry) {
            throw new pytorch.Error("PyTorch Zip container does not contain 'data.pkl' or 'model.json'.");
        }
        const lastIndex = entry.name.lastIndexOf('/');
        this._prefix = lastIndex === -1 ? '' : entry.name.substring(0, lastIndex + 1);
        this._utf8Decoder = new TextDecoder('utf-8');
    }

    get format() {
        if (this._format === undefined) {
            if (this._entry('model.json')) {
                this._format = this._entry('attributes.pkl') ? 'TorchScript v1.1' : 'TorchScript v1.0';
            }
            else if (this._entry('data.pkl')) {
                const versionEntry = this._entry('version');
                const versionNumber = versionEntry ? this._utf8Decoder.decode(versionEntry.data).split('\n').shift() : '';
                // https://github.com/pytorch/pytorch/blob/master/caffe2/serialize/inline_container.h
                // kProducedFileFormatVersion
                const versionTable = {
                    '1': 'v1.3',
                    '2': 'v1.5', // 7a2889b014ce36fcc333b2c6de6f29f976652f84 (#28122)
                    '3': 'v1.6', // 2ec6a30722b0ef85632a2f3e7ce6f80da403008a (#36085)
                    '4': 'v1.6', // 95489b590f00801bdee7f41783f30874883cf6bb (#38620)
                    '5': 'v1.7'  // cb26661fe4faf26386703180a9045e6ac6d157df (#40364)
                };
                const version = versionTable[versionNumber];
                if (!version) {
                    this._exceptionCallback(new pytorch.Error("Unsupported PyTorch Zip version '" + versionNumber + "'."));
                }
                const constants = this._entry('constants.pkl');
                this._format = (constants ? 'TorchScript' : 'PyTorch') + ' ' + (version || 'v-' + versionNumber.toString() );
            }
        }
        return this._format;
    }

    get producer() {
        return this.data ? this._producer : '';
    }

    get name() {
        return this._name;
    }

    get littleEndian() {
        return true;
    }

    get type() {
        this._load();
        return this._type;
    }

    get data() {
        this._load();
        return this._data;
    }

    get constants() {
        if (this._constants === undefined) {
            this._constants = [];
            const entry = this._entry('constants.pkl');
            if (entry && entry.data) {
                this._constants = this._unpickle(entry.data, this._storage('constants'));
                for (let i = 0; i < this._constants.length; i++) {
                    this._constants[i].__variable__ = 'CONSTANTS.c' + i.toString();
                }
            }
        }
        return this._constants;
    }

    get execution() {
        if (this._execution === undefined) {
            const sources = new Map();
            for (const entry of this._entries) {
                if (entry.name.startsWith(this._prefix + 'code')) {
                    const file = entry.name.substring(this._prefix.length);
                    if (sources.has(file)) {
                        throw new pytorch.Error("Duplicate source file '" + file + "'.");
                    }
                    sources.set(file, entry.data);
                }
            }
            this._execution = new pytorch.Container.Zip.Execution(this._python, sources, this._exceptionCallback, this._metadata);
            const constants = {};
            for (let i = 0; i < this.constants.length; i++) {
                constants['c' + i.toString()] = this.constants[i];
            }
            this._execution.context.set('CONSTANTS', constants);
        }
        return this._execution;
    }

    _entry(name) {
        return this._entries.find((entry) => entry.name == this._prefix + name);
    }

    _load() {
        if (this._data === undefined) {
            this._data = null;
            const dataEntry = this._entry('data.pkl');
            if (dataEntry && dataEntry.data) {
                this._data = this._unpickle(dataEntry.data, this._storage('data'));
            }
            else {
                const modelEntry = this._entry('model.json');
                if (modelEntry) {
                    const model = JSON.parse(this._utf8Decoder.decode(modelEntry.data));
                    this._producer = model.producerName + (model.producerVersion ? ' v' + model.producerVersion : '');
                    this._data = model.mainModule || {};
                    this._name = this._data.name || '';
                    if (this._data.torchscriptArena) {
                        this._torchscriptArena = this._data.torchscriptArena.key;
                    }
                    const queue = [ this._data ];
                    const entries = new Map();
                    for (const entry of this._entries) {
                        entries.set(entry.name, entry.data);
                    }
                    const tensorTypeMap = new Map([
                        [ 'FLOAT', 'Float' ],
                        [ 'FLOAT16', 'Half' ],
                        [ 'DOUBLE', 'Double' ],
                        [ 'INT8', 'Char' ],
                        [ 'INT32', 'Int' ],
                        [ 'INT64', 'Long' ]
                    ]);
                    this._constants = model.tensors || [];
                    for (const tensor of this._constants) {
                        const key = this._prefix + tensor.data.key;
                        if (!tensorTypeMap.has(tensor.dataType)) {
                            throw new pytorch.Error("Unknown tensor data type '" + tensor.dataType + "'.");
                        }
                        const type = tensorTypeMap.get(tensor.dataType);
                        tensor.__module__ = 'torch';
                        tensor.__name__ = 'Tensor';
                        tensor.name = tensor.data.key;
                        tensor.size = tensor.dims ? tensor.dims.map((dim) => parseInt(dim, 10)) : null;
                        tensor.storage = this.execution.invoke('torch.' + type + 'Storage', [ tensor.size ]);
                        tensor.storage.data = entries.get(key);
                    }
                    this._attributes = [];
                    const attributesEntry = this._entry('attributes.pkl');
                    if (attributesEntry && attributesEntry.data) {
                        this._attributes.push(...new this._pickle.Unpickler(attributesEntry.data).load((name, args) => this.execution.invoke(name, args)));
                    }
                    while (queue.length > 0) {
                        const module = queue.shift();
                        if (!module.__module__ && !module.__name__) {
                            module.__module__ = 'torch.nn.modules.module';
                            module.__name__ = 'Module';
                        }
                        if (module.name) {
                            module.__id__ = module.name;
                        }
                        if (module.submodules) {
                            for (const submodule of module.submodules) {
                                module[submodule.name] = submodule;
                                submodule.__parent__ = module;
                                queue.push(submodule);
                            }
                            delete module.submodules;
                        }
                        const attributes = [];
                        if (module.attributes) {
                            attributes.push(...module.attributes);
                            delete module.attributes;
                        }
                        const parameters = [];
                        if (module.parameters) {
                            parameters.push(...module.parameters);
                            delete module.parameters;
                        }
                        if (module.arguments) {
                            parameters.push(...module.arguments);
                            delete module.arguments;
                        }
                        for (const parameter of parameters) {
                            const tensor = this._constants[parameter.tensorId];
                            module[parameter.name] = tensor;
                            if (!parameter.__module__ || !parameter.__name__) {
                                parameter.__module__ = 'torch';
                                parameter.__name__ = 'Tensor';
                            }
                        }
                        for (const attribute of attributes) {
                            module[attribute.name] = this._attributes[attribute.id];
                        }
                    }
                }
            }
            if (this.format.startsWith('TorchScript ')) {
                this._type = 'script';
            }
            else {
                const obj = this._data;
                const root = pytorch.Utility.findModule(obj);
                if (root) {
                    this._type = 'module';
                    this._data = root;
                }
                else {
                    const weights = pytorch.Utility.findWeights(obj);
                    if (weights) {
                        this._type = 'weights';
                        this._data = weights;
                    }
                    else {
                        throw new pytorch.Error('File does not contain root module or state dictionary.');
                    }
                }
            }
        }
    }

    _unpickle(data, storage_map) {
        const deserialized_objects = new Map();
        const persistent_load = (saved_id) => {
            const typename = saved_id.shift();
            if (typename !== 'storage') {
                throw new pytorch.Error("Unknown persistent load type '" + typename + "'.");
            }
            const data_type = saved_id.shift();
            const root_key = saved_id.shift();
            saved_id.shift(); // location
            const size = saved_id.shift();
            let storage = null;
            if (deserialized_objects.has(root_key)) {
                storage = deserialized_objects.get(root_key);
            }
            else {
                storage = this.execution.invoke(data_type, [ size ]);
                storage.data = storage_map.get(root_key);
                deserialized_objects.set(root_key, storage);
            }
            const view_metadata = saved_id.shift();
            if (view_metadata) {
                const view_key = view_metadata.shift();
                view_metadata.shift(); // view_offset
                view_metadata.shift(); // view_size
                let view = null;
                if (deserialized_objects.has(view_key)) {
                    view = deserialized_objects.get(root_key);
                }
                else {
                    view = null; // storage.slice(view_offset, view_offset + view_size);
                    deserialized_objects.set(view_key, view);
                }
                return view;
            }
            return storage;
        };
        return new this._pickle.Unpickler(data).load((name, args) => this.execution.invoke(name, args), persistent_load);
    }

    _storage(dirname) {
        const map = new Map();
        const prefix = this._prefix + dirname + '/';
        for (const entry of this._entries) {
            if (entry.name.startsWith(prefix)) {
                const key = entry.name.substring(prefix.length);
                map.set(key, entry.data);
            }
        }
        return map;
    }

    trace() {
        this._inputs = [];
        this._outputs = [];
        this.execution.reset();
        if (this._torchscriptArena) {
            const program = this.execution.parse(this._torchscriptArena);
            for (const statement of program.body) {
                if (statement.type == 'def') {
                    const self = this;
                    const globals = this.execution.context;
                    const func = {
                        __class__: this.execution.context.scope.builtins.function,
                        __name__: statement.name,
                        __code__: statement,
                        __call__: function(args) {
                            return self.execution.apply(this.__code__, args, globals);
                        }
                    };
                    this.data[statement.name] = func;
                }
            }
        }
        if (this.data.forward) {
            const args = [ this.data ]; // self
            if (this.data.forward.__code__ && this.data.forward.__code__.parameters) {
                for (const parameter of this.data.forward.__code__.parameters) {
                    const defaultValue = (type) => {
                        if (type.type === 'type' && type.name.type) {
                            switch (type.name.value) {
                                case 'Tensor':
                                    return { __module__: 'torch', __name__: 'Tensor', __variable__: parameter.name, __origin__: 'trace-input-tensor' };
                                case 'Tuple':
                                    return type.arguments.map((type) => defaultValue(type));
                                case 'List':
                                    return type.arguments.map((type) => defaultValue(type));
                                case 'Dict':
                                    return {};
                                case 'int':
                                    return 0;
                                case 'float':
                                    return 0.0;
                                case 'Optional':
                                    return undefined;
                            }
                        }
                        throw new pytorch.Error("Unknown function parameter type '" + JSON.stringify(type) + "'.");
                    };
                    if (parameter.name !== 'self') {
                        const type = parameter.parameterType;
                        const value = defaultValue(type);
                        if (pytorch.Utility.isTensor(value)) {
                            value.__variable__ = parameter.name;
                            value.__origin__ = 'trace-input-tensor';
                            this._inputs.push(parameter.name);
                        }
                        args.push(value);
                    }
                }
            }
            const result = this.data.forward.__call__(args);
            const outputs = !Array.isArray(result) ? [ result ] : result;
            for (const output of outputs) {
                if (pytorch.Utility.isTensor(output)) {
                    this._outputs.push(output.__variable__);
                }
            }
            this._nodes = this.execution.nodes;
            return true;
        }
        throw new pytorch.Error("Module 'forward' not implemented.");
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }

    get nodes() {
        return this._nodes;
    }
};

pytorch.Container.Zip.Execution = class extends pytorch.Execution {

    constructor(python, sources, exceptionCallback, metadata) {
        super(python, sources, exceptionCallback);
        this._metadata = metadata;
        this.reset();
    }

    reset() {
        this._nodes = [];
        this._variableIndex = 0;
    }

    get nodes() {
        return this._nodes;
    }

    call(target, name, args, context) {
        let resolvedTarget = pytorch.Utility.target(target);
        let outputTypes = null;
        if (resolvedTarget && resolvedTarget + '.' + name === 'ops.prim.NumToTensor' &&
            args.length === 1 && args[0].type === 'call' && args[0].target.member.type == 'id') {
            const innerCall = args[0];
            resolvedTarget = pytorch.Utility.target(innerCall.target.target);
            args = innerCall.arguments;
            name = innerCall.target.member.value;
            outputTypes = [ 'int64' ];
        }
        if (resolvedTarget) {
            const type = resolvedTarget + '.' + name;
            // https://github.com/pytorch/pytorch/blob/master/aten/src/ATen/native/native_functions.yaml
            let schemas = this._metadata.type(type);
            if (schemas) {
                schemas = !Array.isArray(schemas) ? [ schemas ] : schemas;
                const evalArgs = args.map((argument) => argument.type === '=' && argument.target && argument.target.type === 'id' ? this.expression(argument.expression, context) : this.expression(argument, context));
                for (const schema of schemas) {
                    const copyArgs = Array.prototype.slice.call(args);
                    const copyEvalArgs = Array.prototype.slice.call(evalArgs);
                    const node = {
                        type: schema.name,
                        inputs: [],
                        attributes: [],
                        outputs: []
                    };
                    const referencedParameters = [];
                    let next = false;
                    const parameters = Array.prototype.slice.call(schema.inputs || []).concat(Array.prototype.slice.call(schema.attributes || []));
                    while (copyEvalArgs.length > 0) {

                        if (parameters.length <= 0) {
                            next = true;
                            break;
                        }

                        const paramsBase = copyEvalArgs[0];
                        if (paramsBase && paramsBase.__module__ === '__torch__.torch.classes.quantized') {
                            switch (paramsBase.__name__) {
                                case 'Conv2dPackedParamsBase':
                                    copyArgs.shift();
                                    copyEvalArgs.shift();
                                    copyArgs.unshift({ type: null });
                                    copyEvalArgs.unshift(paramsBase.bias);
                                    copyArgs.unshift({ type: null });
                                    copyEvalArgs.unshift(paramsBase.weight);
                                    break;
                                case 'LinearPackedParamsBase':
                                    copyArgs.shift();
                                    copyEvalArgs.shift();
                                    copyArgs.unshift({ type: null });
                                    copyEvalArgs.unshift(paramsBase.bias);
                                    copyArgs.unshift({ type: null });
                                    copyEvalArgs.unshift(paramsBase.weight);
                                    break;
                                default:
                                    throw new pytorch.Error("Unsupported type '" + paramsBase.__name__ + "'.");
                            }
                        }
                        const op_context = copyEvalArgs[0];
                        if (op_context && op_context.__module__ === '__torch__.torch.classes.xnnpack') {
                            switch (op_context.__name__) {
                                case 'LinearOpContext':
                                case 'Conv2dOpContext':
                                    copyArgs.shift();
                                    copyEvalArgs.shift();
                                    for (const key of Object.keys(op_context).filter((key) => Number.isInteger(parseInt(key, 10)))) {
                                        copyArgs.push({ type: null });
                                        copyEvalArgs.push(op_context[key]);
                                    }
                                    break;
                                default:
                                    throw new pytorch.Error("Unsupported type '" + paramsBase.__name__ + "'.");
                            }
                        }

                        if (copyArgs.every((arg) => arg.type === '=' && arg.target && arg.target.type === 'id') &&
                            parameters.every((parameter) => parameter.type !== 'Tensor' && parameter.type !== 'Tensor[]')) {
                            const map = new Map();
                            for (const parameter of parameters) {
                                map.set(parameter.name, parameter);
                            }
                            while (copyArgs.length > 0) {
                                const argument = copyArgs.shift();
                                const value = copyEvalArgs.shift();
                                const parameter = map.get(argument.target.value);
                                if (!parameter) {
                                    next = true;
                                    break;
                                }
                                if (!pytorch.Utility.isType(value, parameter.type)) {
                                    if (parameter.optional) {
                                        continue;
                                    }
                                    next = true;
                                    break;
                                }
                                node.attributes.push({ name: parameter.name, value: value });
                            }
                            continue;
                        }
                        if (next) {
                            break;
                        }

                        const parameter = parameters.shift();
                        const argument = copyEvalArgs[0];

                        switch (parameter.type) {
                            case 'Tensor': {
                                if (Array.isArray(argument) || (!pytorch.Utility.isTensor(argument) && argument !== null && argument !== undefined)) {
                                    if (parameter.optional) {
                                        if (argument === undefined) {
                                            copyArgs.shift();
                                            copyEvalArgs.shift();
                                        }
                                        continue;
                                    }
                                    next = true;
                                    break;
                                }
                                copyArgs.shift();
                                copyEvalArgs.shift();
                                const item = (argument === null || argument === undefined) ? {} : argument;
                                item.__variable__ = item.__variable__ || this.variable();
                                const inputs = [];
                                inputs.push({ id: item.__variable__ });
                                referencedParameters.push(item);
                                node.inputs.push(inputs);
                                break;
                            }
                            case 'Tensor[]': {
                                const argument = copyEvalArgs[0];
                                if (!Array.isArray(argument) || !argument.every((item) => pytorch.Utility.isTensor(item) || item === null)) {
                                    if (parameter.optional) {
                                        continue;
                                    }
                                    next = true;
                                    break;
                                }
                                copyArgs.shift();
                                copyEvalArgs.shift();
                                const inputs = [];
                                for (let item of argument) {
                                    if (item === null) {
                                        item = {};
                                    }
                                    item.__variable__ = item.__variable__ || this.variable();
                                    inputs.push({ id: item.__variable__ });
                                    referencedParameters.push(item);
                                }
                                node.inputs.push(inputs);
                                break;
                            }
                            default: {
                                const arg = copyArgs[0];
                                if (!pytorch.Utility.isType(argument, parameter.type) && argument !== null) {
                                    if (parameter.optional) {
                                        continue;
                                    }
                                    next = true;
                                    break;
                                }
                                if (arg.type !== '=') {
                                    copyArgs.shift();
                                    copyEvalArgs.shift();
                                    node.attributes.push({ name: parameter.name, value: argument });
                                }
                                else {
                                    throw new pytorch.Error('Expected named argument.');
                                }
                                break;
                            }
                        }
                        if (next) {
                            break;
                        }
                    }
                    if (next) {
                        continue;
                    }
                    const result = [];
                    for (const paramter of schema.outputs) {
                        switch (paramter.type) {
                            case 'Tensor': {
                                const parameter = { __module__: 'torch', __name__: 'Tensor', __origin__: 'invoke-output-' + type };
                                switch (type) {
                                    case 'torch.cat':
                                    case 'torch.conv2d':
                                    case 'torch.dropout':
                                    case 'torch.flatten':
                                    case 'torch.max_pool2d':
                                    case 'torch.adaptive_avg_pool2d':
                                    case 'torch.avg_pool2d':
                                    case 'torch.quantize_per_tensor':
                                    case 'torch.relu_':
                                    case 'torch.hardtanh_':
                                    case 'torch.slice': {
                                        parameter.size = [ NaN, NaN, NaN, NaN ];
                                        break;
                                    }
                                    case 'torch.conv3d': {
                                        parameter.size = [ NaN, NaN, NaN, NaN, NaN ];
                                        break;
                                    }
                                    case 'torch.embedding': {
                                        parameter.size = [ NaN, NaN, NaN ];
                                        break;
                                    }
                                    case 'torch.ones':
                                    case 'torch.zeros':
                                    case 'torch.zeros_like': {
                                        parameter.size = this.expression(args[0], context);
                                        break;
                                    }
                                    case 'ops.quantized.cat':
                                    case 'ops.quantized.cat_relu':
                                    case 'ops.quantized.linear':
                                    case 'ops.quantized.conv2d':
                                    case 'ops.quantized.conv2d_relu':
                                    case 'ops.quantized.add_relu':
                                        parameter.size = [ NaN, NaN, NaN, NaN ];
                                        break;
                                }
                                parameter.__variable__ = this.variable();
                                result.push(parameter);
                                node.outputs.push([ { id: parameter.__variable__ } ]);
                                break;
                            }
                            case 'Tensor[]': {
                                let count = 1;
                                switch (type) {
                                    case 'torch.chunk':
                                        count = node.attributes.filter((attribute) => attribute.name == 'chunks')[0].value;
                                        break;
                                }
                                const tensors = [];
                                const outputs = [];
                                for (let i = 0; i < count; i ++) {
                                    const tensor = { __module__: 'torch', __name__: 'Tensor', __origin__: 'invoke-output-' + type };
                                    tensor.__variable__ = this.variable();
                                    tensors.push(tensor);
                                    outputs.push({ id: tensor.__variable__ });
                                }
                                result.push(tensors);
                                node.outputs.push(outputs);
                                break;
                            }
                            default: {
                                if (!outputTypes || schema.outputs.length !== 1 || schema.outputs[0].type !== outputTypes[0]) {
                                    next = true;
                                    break;
                                }
                                const tensor = { __module__: 'torch', __name__: 'Tensor', __origin__: 'invoke-output-' + type };
                                tensor.__variable__ = this.variable();
                                result.push(tensor);
                                node.outputs.push([ { id: tensor.__variable__ } ]);
                                break;
                            }
                        }
                    }
                    if (next) {
                        continue;
                    }
                    for (const parameter of referencedParameters) {
                        parameter.__count__ = (parameter.__count__ || 0) + 1;
                    }
                    this.push(node);
                    if (result.length > 1) {
                        return result;
                    }
                    return result[0];
                }
            }
        }
        return super.call(target, name, args, context);
    }

    push(node) {
        this._nodes.push(node);
    }

    variable() {
        this._variableIndex++;
        return this._variableIndex.toString();
    }
};

pytorch.ScalarType = {
    uint8: 0, int8: 1, int16: 2, int32: 3, int64: 4,
    float16: 5, float32: 6, float64: 7,
    complex32: 8, complex64: 9, complex128: 10,
    boolean: 11,
    qint8: 12, quint8: 13, qint32: 14, bfloat16: 15
};

pytorch.MemoryFormat = {
    Contiguous: 0, Preserve: 1, ChannelsLast: 2, ChannelsLast3d: 3
};

pytorch.Layout = {
    Strided: 0, Sparse: 1, Mkldnn: 2
};

pytorch.Utility = class {

    static target(expression) {
        if (expression.type == 'id') {
            return expression.value;
        }
        if (expression.type == '.') {
            return pytorch.Utility.target(expression.target) + '.' + pytorch.Utility.target(expression.member);
        }
        return null;
    }

    static isTensor(obj) {
        if (obj && obj.__module__ && obj.__name__) {
            switch (obj.__module__) {
                case 'torch':
                case 'torch.cuda':
                    return obj.__name__.endsWith('Tensor');
                case 'torch.nn.parameter':
                    return obj.__name__ === 'Parameter';
            }
        }
        return false;
    }

    static toTensor(obj) {
        if (obj && obj.__module__ && obj.__name__) {
            switch (obj.__module__) {
                case 'torch':
                case 'torch.cuda':
                    return obj.__name__.endsWith('Tensor') ? obj : null;
                case 'torch.nn.parameter':
                    return obj.__name__ === 'Parameter' ? obj.data : null;
            }
        }
        return null;
    }

    static isType(obj, type) {
        switch (type) {
            case 'Tensor':
                return !Array.isArray(obj) && (pytorch.Utility.isTensor(obj) || obj === null);
            case 'Tensor[]':
                return Array.isArray(obj) && obj.length > 0 && obj.every((tensor) => pytorch.Utility.isTensor(tensor) || tensor === null);
            case 'Scalar':
                return obj !== null || obj !== Object(obj);
            case 'boolean':
                return obj === true || obj === false;
            case 'int64':
                return Number.isInteger(obj) || isNaN(obj);
            case 'int64[]':
                return Array.isArray(obj) && obj.every((item) => Number.isInteger(item) || Number.isNaN(item) || item === undefined);
            case 'int64[1]':
                return pytorch.Utility.isType(obj, 'int64') || pytorch.Utility.isType(obj, 'int64[]');
            case 'float32':
            case 'float64':
                return obj !== null && obj !== Object(obj);
            case 'Layout':
            case 'ScalarType':
            case 'MemoryFormat':
                return Number.isInteger(obj) || obj === null;
            case 'Device':
                return obj === null || obj === Object(obj);
        }
        return true;
    }

    static findModule(root) {
        if (root) {
            const keys = [ '', 'model', 'net' ];
            for (const key of keys) {
                const obj = key === '' ? root : root[key];
                if (obj && obj._modules) {
                    return obj;
                }
            }
        }
        return null;
    }

    static findWeights(root) {
        if (!root) {
            return null;
        }
        if (root instanceof Map) {
            const obj = {};
            for (const pair of root) {
                const key = pair[0];
                const value = pair[1];
                obj[key] = value;
            }
            root = obj;
        }
        const keys = root && !Array.isArray(root) ? Object.keys(root) : [];
        if (keys.length > 1) {
            keys.splice(0, keys.length);
        }
        keys.push(...[
            'state_dict', 'state', 'model_state', 'model', 'model_state_dict', 'model_dict', 'net_dict', 'params', 'generator',
            'discriminator', 'g_state', 'network', 'net', 'netG', 'net_states', 'state_dict_stylepredictor', 'state_dict_ghiasi', ''
        ]);
        for (const key of keys) {
            const obj = key === '' ? root : root[key];
            let layers = null;
            layers = layers || pytorch.Utility._convertTensor(obj);
            layers = layers || pytorch.Utility._convertStateDictList(obj);
            layers = layers || pytorch.Utility._convertStateDictMap(obj);
            layers = layers || pytorch.Utility._convertStateDictGroupMap(obj);
            if (layers) {
                return [ { layers: layers } ];
            }
            if (obj) {
                const models = [];
                for (const key of Object.keys(obj)) {
                    const value = obj[key];
                    layers = layers || pytorch.Utility._convertTensor(value);
                    layers = layers || pytorch.Utility._convertStateDictList(value);
                    layers = layers || pytorch.Utility._convertStateDictMap(value);
                    layers = layers || pytorch.Utility._convertStateDictGroupMap(value);
                    if (layers) {
                        models.push({ name: key.toString(), layers: layers });
                    }
                }
                if (models.length > 1) {
                    return models;
                }
            }
        }
        return null;
    }

    static _convertTensor(tensor) {
        if (tensor && pytorch.Utility.isTensor(tensor)) {
            const argument = { id: '', value: tensor };
            const parameter = { name: 'value', arguments: [ argument ] };
            return [ { states: [ parameter ] } ];
        }
        return null;
    }

    static _convertStateDictList(list) {
        if (list && Array.isArray(list) && list.every((obj) => obj.__module__ && obj.__name__ && Object.keys(obj).filter((key) => pytorch.Utility.isTensor(obj[key]).length > 0))) {
            const layers = [];
            for (const obj of list) {
                const layer = { type: obj.__module__ + '.' + obj.__name__, states: [], attributes: [] };
                for (const key of Object.keys(obj)) {
                    const value = obj[key];
                    if (pytorch.Utility.isTensor(value)) {
                        layer.states.push({ name: key, arguments: [ { id: '', value: value } ] });
                    }
                    else {
                        layer.attributes.push({ name: key, value: value });
                    }
                }
                layers.push(layer);
            }
            return layers;
        }
        if (list && !Array.isArray(list) && !(list instanceof Map)) {
            list = new Map(Object.keys(list).filter((key) => key !== '_metadata').map((key) => [ key, list[key] ]));
        }
        if (list && list instanceof Map) {
            for (const item of list) {
                const key = item[0];
                const value = item[1];
                if (!key || !value) {
                    return null;
                }
                if (key === '_metadata') {
                    continue;
                }
                if (pytorch.Utility.isTensor(value)) {
                    continue;
                }
                if (key.endsWith('._packed_params.dtype')) {
                    continue;
                }
                if (key.endsWith('._packed_params._packed_params') && Array.isArray(value) && value.every((item) => pytorch.Utility.isTensor(item))) {
                    continue;
                }
                return null;
            }
            const layers = new Map();
            for (const item of list) {
                const key = item[0];
                const value = item[1];
                if (key === '_metadata') {
                    continue;
                }
                if (value !== null) {
                    let layerName = '';
                    let parameter = '';
                    if (key.endsWith('_packed_params.dtype')) {
                        parameter = '_packed_params.dtype';
                        layerName = key.substring(0, key.length - parameter.length - 1);
                    }
                    else if (key.endsWith('_packed_params._packed_params') && Array.isArray(value)) {
                        parameter = '_packed_params._packed_params';
                        layerName = key.substring(0, key.length - parameter.length - 1);
                    }
                    else {
                        let split = key.split('.');
                        if (split.length < 2) {
                            split = [ '', split[0] ];
                        }
                        parameter = split.pop();
                        layerName = split.join('.');
                    }
                    if (!layers.has(layerName)) {
                        layers.set(layerName, { name: layerName, states: [], attributes: [] });
                    }
                    const layer = layers.get(layerName);
                    switch (parameter) {
                        case '_packed_params.dtype':
                            layer.attributes.push({ name: parameter, value: value });
                            break;
                        case '_packed_params._packed_params':
                            layer.states.push({ name: parameter, arguments: value.map((item) => { return { id: '', value: item }; }) });
                            break;
                        default:
                            layer.states.push({ name: parameter, arguments: [ { id: key, value: value } ] });
                            if (layer.name == '' && layer.states.length > 4) {
                                return null;
                            }
                            break;
                    }
                }
            }
            return Array.from(layers.values());
        }
        return null;
    }

    static _convertStateDictMap(obj) {
        if (!obj || Array.isArray(obj)) {
            return null;
        }
        const state_dict = [];
        const state_map = {};
        for (const key in obj) {
            if (key === '_metadata') {
                continue;
            }
            const split = key.split('.');
            if (split.length < 1) {
                return null;
            }
            const state = {};
            state.id = key;
            state.name = split.pop();
            state.value = pytorch.Utility.toTensor(obj[key]);
            if (!pytorch.Utility.isTensor(state.value)) {
                return null;
            }
            const state_group_name = split.join('.');
            let state_group = state_map[state_group_name];
            if (!state_group) {
                state_group = {};
                state_group.name = state_group_name;
                state_group.states = [];
                state_map[state_group_name] = state_group;
                state_dict.push(state_group);
            }
            state_group.states.push({ name: state.name, arguments: [ state ] });
        }
        return state_dict;
    }

    static _convertStateDictGroupMap(obj) {
        if (!obj || Array.isArray(obj)) {
            return null;
        }
        const state_dict = [];
        const state_map = {};
        for (const state_group_name in obj) {
            let state_group = state_map[state_group_name];
            if (!state_group) {
                state_group = {};
                state_group.name = state_group_name;
                state_group.states = [];
                state_group.attributes = [];
                state_map[state_group_name] = state_group;
                state_dict.push(state_group);
            }
            const item = obj[state_group_name];
            if (!item) {
                return null;
            }
            if (item instanceof Map) {
                for (const pair of item) {
                    const key = pair[0];
                    const value = pair[1];
                    if (key === '_metadata') {
                        continue;
                    }
                    if (!key) {
                        return null;
                    }
                    if (value && !pytorch.Utility.isTensor(value)) {
                        return null;
                    }
                    const argument = { id: state_group_name + '.' + key, value: value };
                    state_group.states.push({ name: key, arguments: [ argument ] });
                }
            }
            else if (item instanceof Uint8Array) {
                return null;
            }
            else if (Object(item) === item) {
                let hasTensors = false;
                for (const key in item) {
                    const value = pytorch.Utility.toTensor(item[key]);
                    if (pytorch.Utility.isTensor(value)) {
                        const argument = { id: state_group_name + '.' + key, value: value };
                        state_group.states.push({ name: key, arguments: [ argument ] });
                        hasTensors = true;
                    }
                    else if (value !== Object(value)) {
                        state_group.attributes.push({ name: key, value: value });
                    }
                    else {
                        return null;
                    }
                }
                if (!hasTensors) {
                    return null;
                }
            }
            else {
                return null;
            }
        }
        return state_dict;
    }

    static readInt32(buffer) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        return view.getInt32(0, true);
    }

    static readInt64(buffer) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        return view.getInt64(0, true).toNumber();
    }
};

pytorch.nnapi = {};

pytorch.nnapi.SerializedModel = class {

    constructor(serialized_model /*, buffer_ptrs */) {
        const reader = new pytorch.nnapi.SerializedModel.BinaryReader(serialized_model);
        this.version = reader.int32();
        if (this.version !== 1) {
            throw new pytorch.Error('Invalid NNAPI serialized model version.');
        }
        const operands = new Array(reader.int32());
        const values = new Array(reader.int32());
        this.operations = new Array(reader.int32());
        this.inputs = new Array(reader.int32());
        this.outputs = new Array(reader.int32());
        const types = new Map([
            [ 0, 'float32' ],
            [ 1, 'int32' ],
            [ 2, 'uint32' ],
            [ 3, 'float32' ],
            [ 4, 'int32*' ],
            [ 5, 'quant8_asymm*' ],
            [ 6, 'boolean' ],
            [ 7, 'quant16_symm*' ],
            [ 8, 'float16*' ],
            [ 9, 'boolean*' ],
            [ 10, 'float16' ],
            [ 11, 'quant8_symm_per_channel*' ],
            [ 12, 'quant16_asymm*' ],
            [ 13, 'quant8_symm*' ],
            [ 14, 'quant8_asymm_signed*' ],
            [ 16, 'model' ]
        ]);
        const operations = new Map([
            [ 0, 'ADD' ],
            [ 1, 'AVERAGE_POOL_2D' ],
            [ 2, 'CONCATENATION' ],
            [ 3, 'CONV_2D' ],
            [ 4, 'DEPTHWISE_CONV_2D' ],
            [ 5, 'DEPTH_TO_SPACE' ],
            [ 6, 'DEQUANTIZE' ],
            [ 7, 'EMBEDDING_LOOKUP' ],
            [ 8, 'FLOOR' ],
            [ 9, 'FULLY_CONNECTED' ],
            [ 10, 'HASHTABLE_LOOKUP' ],
            [ 11, 'L2_NORMALIZATION' ],
            [ 12, 'L2_POOL_2D' ],
            [ 13, 'LOCAL_RESPONSE_NORMALIZATION' ],
            [ 14, 'LOGISTIC' ],
            [ 15, 'LSH_PROJECTION' ],
            [ 16, 'LSTM' ],
            [ 17, 'MAX_POOL_2D' ],
            [ 18, 'MUL' ],
            [ 19, 'RELU' ],
            [ 20, 'RELU1' ],
            [ 21, 'RELU6' ],
            [ 22, 'RESHAPE' ],
            [ 23, 'RESIZE_BILINEAR' ],
            [ 24, 'RNN' ],
            [ 25, 'SOFTMAX' ],
            [ 26, 'SPACE_TO_DEPTH' ],
            [ 27, 'SVDF' ],
            [ 28, 'TANH' ],
            [ 29, 'BATCH_TO_SPACE_ND' ],
            [ 30, 'DIV' ],
            [ 31, 'MEAN' ],
            [ 32, 'PAD' ],
            [ 33, 'SPACE_TO_BATCH_ND' ],
            [ 34, 'SQUEEZE' ],
            [ 35, 'STRIDED_SLICE' ],
            [ 36, 'SUB' ],
            [ 37, 'TRANSPOSE' ],
            [ 38, 'ABS' ],
            [ 39, 'ARGMAX' ],
            [ 40, 'ARGMIN' ],
            [ 41, 'AXIS_ALIGNED_BBOX_TRANSFORM' ],
            [ 42, 'BIDIRECTIONAL_SEQUENCE_LSTM' ],
            [ 43, 'BIDIRECTIONAL_SEQUENCE_RNN' ],
            [ 44, 'BOX_WITH_NMS_LIMIT' ],
            [ 45, 'CAST' ],
            [ 46, 'CHANNEL_SHUFFLE' ],
            [ 47, 'DETECTION_POSTPROCESSING' ],
            [ 48, 'EQUAL' ],
            [ 49, 'EXP' ],
            [ 50, 'EXPAND_DIMS' ],
            [ 51, 'GATHER' ],
            [ 52, 'GENERATE_PROPOSALS' ],
            [ 53, 'GREATER' ],
            [ 54, 'GREATER_EQUAL' ],
            [ 55, 'GROUPED_CONV_2D' ],
            [ 56, 'HEATMAP_MAX_KEYPOINT' ],
            [ 57, 'INSTANCE_NORMALIZATION' ],
            [ 58, 'LESS' ],
            [ 59, 'LESS_EQUAL' ],
            [ 60, 'LOG' ],
            [ 61, 'LOGICAL_AND' ],
            [ 62, 'LOGICAL_NOT' ],
            [ 63, 'LOGICAL_OR' ],
            [ 64, 'LOG_SOFTMAX' ],
            [ 65, 'MAXIMUM' ],
            [ 66, 'MINIMUM' ],
            [ 67, 'NEG' ],
            [ 68, 'NOT_EQUAL' ],
            [ 69, 'PAD_V2' ],
            [ 70, 'POW' ],
            [ 71, 'PRELU' ],
            [ 72, 'QUANTIZE' ],
            [ 73, 'QUANTIZED_16BIT_LSTM' ],
            [ 74, 'RANDOM_MULTINOMIAL' ],
            [ 75, 'REDUCE_ALL' ],
            [ 76, 'REDUCE_ANY' ],
            [ 77, 'REDUCE_MAX' ],
            [ 78, 'REDUCE_MIN' ],
            [ 79, 'REDUCE_PROD' ],
            [ 80, 'REDUCE_SUM' ],
            [ 81, 'ROI_ALIGN' ],
            [ 82, 'ROI_POOLING' ],
            [ 83, 'RSQRT' ],
            [ 84, 'SELECT' ],
            [ 85, 'SIN' ],
            [ 86, 'SLICE' ],
            [ 87, 'SPLIT' ],
            [ 88, 'SQRT' ],
            [ 89, 'TILE' ],
            [ 90, 'TOPK_V2' ],
            [ 91, 'TRANSPOSE_CONV_2D' ],
            [ 92, 'UNIDIRECTIONAL_SEQUENCE_LSTM' ],
            [ 93, 'UNIDIRECTIONAL_SEQUENCE_RNN' ],
            [ 94, 'RESIZE_NEAREST_NEIGHBOR' ],
            [ 95, 'QUANTIZED_LSTM' ],
            [ 96, 'IF' ],
            [ 97, 'WHILE' ],
            [ 98, 'ELU' ],
            [ 99, 'HARD_SWISH' ],
            [ 100, 'FILL' ],
            [ 101, 'RANK' ],
        ]);
        for (let i = 0; i < operands.length; i++) {
            const type = reader.int32();
            operands[i] = {
                type: types.has(type) ? types.get(type) : type,
                dimensions: new Array(reader.uint32()),
                scale: reader.float32(),
                zero_point: reader.int32()
            };
        }
        for (let i = 0; i < values.length; i++) {
            values[i] = {
                index: reader.int32(),
                source_type: reader.int32(),
                source_length: reader.uint32()
            };
        }
        for (let i = 0; i < this.operations.length; i++) {
            const operation_type = reader.int32();
            this.operations[i] = {
                operation_type: operations.has(operation_type) ? operations.get(operation_type) : operation_type,
                inputs: new Array(reader.uint32()),
                outputs: new Array(reader.uint32())
            };
        }
        for (const operand of operands) {
            for (let i = 0; i< operand.dimensions.length; i++) {
                operand.dimensions[i] = reader.uint32();
            }
        }
        for (const value of values) {
            const operand = operands[value.index];
            switch (value.source_type) {
                case 0: { // immediate
                    switch (operand.type) {
                        case 'boolean':
                            operand.value = reader.byte() ? true : false;
                            reader.skip(3);
                            break;
                        case 'int32':
                            operand.value = reader.int32();
                            break;
                        case 'int32*':
                            operand.value = reader.bytes(value.source_length);
                            break;
                        default:
                            throw new pytorch.Error("Unsupported NNAPI operand type '" + operand.type.toString() + "'.");
                    }
                    break;
                }
                case 2: { // numbered buffer
                    if (value.source_length !== 12) {
                        throw new pytorch.Error('Invalid NNAPI numbered buffer source length.');
                    }
                    const number = reader.uint32();
                    const offset = reader.uint32();
                    const operand_length = reader.uint32();
                    operand.value = [ number, offset, operand_length ];
                    break;
                }
                case 3: { // numbered memory
                    throw new pytorch.Error('NNAPI numbered memory buffer not implemented.');
                }
                default: {
                    throw new pytorch.Error('Unsupported NNAPI value source type.');
                }
            }
        }
        for (const operation of this.operations) {
            for (let i = 0; i< operation.inputs.length; i++) {
                operation.inputs[i] = operands[reader.uint32()];
            }
            for (let i = 0; i< operation.outputs.length; i++) {
                operation.outputs[i] = operands[reader.uint32()];
            }
        }
        for (let i = 0; i< this.inputs.length; i++) {
            this.inputs[i] = operands[reader.uint32()];
        }
        for (let i = 0; i< this.outputs.length; i++) {
            this.outputs[i] = operands[reader.uint32()];
        }
        if (!reader.end()) {
            throw new pytorch.Error('Invalid NNAPI serialized model length.');
        }
    }
};

pytorch.nnapi.SerializedModel.BinaryReader = class {

    constructor(buffer) {
        this._buffer = buffer;
        this._dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        this._position = 0;
    }

    end() {
        return this._position >= this._buffer.length;
    }

    skip(offset) {
        this._position += offset;
        if (this._position > this._buffer.length) {
            throw new pytorch.Error('Expected ' + (this._position - this._buffer.length) + ' more bytes. The file might be corrupted. Unexpected end of file.');
        }
    }

    bytes(length) {
        const position = this._position;
        this.skip(length);
        return this._buffer.subarray(position, this._position);
    }

    byte() {
        const position = this._position;
        this.skip(1);
        return this._dataView.getUint8(position, true);
    }

    int32() {
        const position = this._position;
        this.skip(4);
        return this._dataView.getInt32(position, true);
    }

    uint32() {
        const position = this._position;
        this.skip(4);
        return this._dataView.getUint32(position, true);
    }

    int64() {
        const value = this.int32();
        if (this.int32() !== 0) {
            throw new pytorch.Error('Invalid int64 value.');
        }
        return value;
    }

    float32() {
        const position = this._position;
        this.skip(4);
        return this._dataView.getFloat32(position, true);
    }
};

pytorch.Metadata = class {

    static open(host) {
        if (pytorch.Metadata._metadata) {
            return Promise.resolve(pytorch.Metadata._metadata);
        }
        else {
            return host.request(null, 'pytorch-metadata.json', 'utf-8').then((data) => {
                pytorch.Metadata._metadata = new pytorch.Metadata(data);
                return pytorch.Metadata._metadata;
            }).catch(() => {
                pytorch.Metadata._metadata = new pytorch.Metadata(null);
                return pytorch.Metadata._metadata;
            });
        }
    }

    constructor(data) {
        this._map = new Map();
        this._attributeCache = new Map();
        if (data) {
            const items = JSON.parse(data);
            if (items) {
                for (const item of items) {
                    if (item.name && item.schema) {
                        item.schema.name = item.name;
                        this._map.set(item.name, item.schema);
                    }
                    const index = item.name.indexOf(':');
                    if (index !== -1) {
                        const name = item.name.substring(0, index);
                        if (!this._map.has(name)) {
                            this._map.set(name, []);
                        }
                        this._map.get(name).push(item.name);
                    }
                }
            }
        }
    }

    type(name) {
        const schema = this._map.get(name);
        if (schema) {
            return Array.isArray(schema) ? schema.map((name) => this._map.get(name)) : schema;
        }
        return null;
    }

    attribute(type, name) {
        const attributeName = type + ':' + name;
        if (!this._attributeCache.has(attributeName)) {
            this._attributeCache.set(attributeName, null);
            const schema = this.type(type);
            if (schema) {
                if (schema.inputs) {
                    for (const input of schema.inputs) {
                        this._attributeCache.set(type + ':' + input.name, input);
                    }
                }
                if (schema.attributes) {
                    for (const attribute of schema.attributes) {
                        this._attributeCache.set(type + ':' + attribute.name, attribute);
                    }
                }
            }
        }
        return this._attributeCache.get(attributeName);
    }
};

pytorch.Error = class extends Error {

    constructor(message) {
        super(message);
        this.name = 'Error loading PyTorch model.';
    }
};

if (typeof module !== 'undefined' && typeof module.exports === 'object') {
    module.exports.ModelFactory = pytorch.ModelFactory;
}
