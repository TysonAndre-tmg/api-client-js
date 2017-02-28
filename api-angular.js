// This file may run in a browser, so wrap it in an IIFE.
(function() {
    'use strict';

    var context = typeof exports !== 'undefined' ? exports : window;
    var base64 = context.btoa || require('btoa');
    var Promise = context.Promise;
    if (!Promise && typeof(require) === 'function') {
        Promise = require('bluebird');
    }

    var COOKIE_KEYVALUE_SEPARATOR = /; */;

    // ## TaggedApi Constructor
    //
    // Creates a new Tagged API client that is bound to the request's cookies.
    // Each full page request by the user should create a new instance of the API
    // client to ensure that the calls are made on behalf of the user.
    //
    // **Params:**
    //
    //     endpoint: [string] URL to post API calls to.
    //     options: [object|null] Common options that are used with each API call.
    //     http: [HttpAdapter|null] Adapter to make HTTP requests.
    var TaggedApi = function(endpoint, options, http) {
        this._endpoint = endpoint;

        // Default to the vanilla adapter should clients not pass adapter
        this._http = (typeof http !== 'undefined') ? http : new VanillaAdapter(context.XMLHttpRequest, context.Promise || require('bluebird'));

        // API calls that are made within a single JS execution frame will be added
        // to the queue and processed as a whole on the next tick.
        this._queue = [];

        // When the queue size exceeds this value, an HTTP request will be trigged
        // to flush the queue. Defaults to `null`, meaning no limit.
        this._maxQueueSize = null;

        // This timeout is used to trigger the HTTP request on the next tick. All
        // API calls that are added to the queue will be batched together.
        this._batchTimeout = null;

        // Common parameters that will be passed with each API call are stored here.
        this._options = mergeRecursive({
            // These parameters are appended to the endpoint as a query string.
            query: {},

            // Parameters registered here will be merged with parameters that are
            // passed in to the `execute()` call.
            params: {
                // Track is autogenerated per API instance, allowing the API server
                // to know which API calls are made within a single requst.
                track: this._generateTrackId()
            },

            // How long to wait before aborting long-running requests.
            timeout: 10000
        }, options || {});

        // The user's cookies are required by the API to properly handle the request.
        // Keep a reference so that we can ensure we use updated cookies.
        this._cookies = {};
        if (options.cookies) {
            var cookies = options.cookies.split(COOKIE_KEYVALUE_SEPARATOR);
            cookies.forEach(function(cookie) {
                var keyValuePair = cookie.split('=', 2);
                this._cookies[keyValuePair[0]] = keyValuePair[1];
            }.bind(this));
        }

        var timeout = parseInt(this._options.timeout, 10) || 10000;
        if (timeout < 0) timeout = 10000;
        this._http.setTimeout(timeout);

        this._events = {};

        this._cache = {};
    };

    // Generates a random track ID.
    TaggedApi.prototype._generateTrackId = function() {
        return base64(Math.random() * (100000000)).substr(0, 10);
    };

    // Sets the max queue size.
    TaggedApi.prototype.setMaxQueueSize = function(maxQueueSize) {
        this._maxQueueSize = maxQueueSize;
    };

    // Returns the max queue size, or null if unlimited.
    TaggedApi.prototype.getMaxQueueSize = function(maxQueueSize) {
        return this._maxQueueSize;
    };

    // Executes an API call with given method and params. Returns a promise that
    // is resolved with the API call's response data, or rejected if the API response
    // cannot be parsed as JSON. Additionally, if the result contains a `stat` property
    // that does not equal `ok`, then the promise will be rejected.
    TaggedApi.prototype.execute = function(method, params, config) {
        if (!method || typeof method !== "string") {
            throw new Error("Method is required to execute API calls");
        }

        // check if we should clear old caches
        var randomNum = Math.random();
        if (randomNum > 0.99) {
            var now = new Date().getTime();
            for (var cacheEntry in this._cache) {
                if (this._cache[cacheEntry].expires < now) {
                    delete this._cache[cacheEntry];
                }
            }
        }

        var cacheKey;
        // check if config.cache is passed in
        if (config && config.cache) {
            // create a cache key based on method and params
            cacheKey = method + ':' + JSON.stringify(params);
            // check cache for existing promise
            if (this._cache.hasOwnProperty(cacheKey)) {
                var cache = this._cache[cacheKey];
                var now = new Date().getTime();
                // see if cache is expired - delete if it is
                if (cache.expires > now) {
                    return this._cache[cacheKey];
                } else {
                    delete this._cache[cacheKey];
                }
            }
        }

        var promise = new Promise(function(resolve, reject) {
            var _params = mergeRecursive({}, this._options.params);

            this._queue.push({
                method: method,
                params: mergeRecursive(_params, params || {}),
                deferred: {resolve: resolve, reject: reject},
                timeStart: getHighResolutionTimeStamp()
            });

            if (this._maxQueueSize && this._queue.length >= this._maxQueueSize) {
                // Flush the queue
                this._postToApi();
            } else if (null === this._batchTimeout) {
                this._batchTimeout = setTimeout(this._postToApi.bind(this), 1);
            }
        }.bind(this));

        if (cacheKey) {
            var now = new Date().getTime();
            var expires = (config.cache === true) ? Infinity : (now + (config.cache * 1000));
            this._cache[cacheKey] = {
                expires: expires,
                promise: promise
            };
        }

        return promise;
    };

    TaggedApi.prototype._postToApi = function() {
        var body = stringifyQueue(this._queue);
        var query = {};

        for(var key in this._options.query) {
            query[key] = this._options.query[key];
        }

        var queryParts = [];
        for (var i in query) {
            if (!query.hasOwnProperty(i)) continue;
            queryParts.push(i + '=' + query[i]);
        }

        var queryString = queryParts.join('&');

        this._http.post({
            body: body,
            url: this._endpoint + "?" + queryString,
            cookies: this._options.cookies,
            clientId: this._options.clientId,
            secret: this._options.secret,
            headers: this._options.headers || {},
            timeStart: this._queueTimeStart
        })
        .then(parseResponseBody)
        .then(resolveQueue.bind(this, this._queue))
        .catch(rejectQueue.bind(this, this._queue));

        this.resetQueue();
    };

    // Parses the body of a JSON response and returns an
    // array of objects.
    var parseResponseBody = function(response) {
        var results = [];
        var responses = JSON.parse(response.body);

        // exceptions will be bubbled up
        for (var i in responses) {
            results.push(JSON.parse(responses[i]));
        }

        return results;
    };


    // Resolves all queued promises with the associated
    // result from the API response.
    var resolveQueue = function(queue, results) {
        for (var i in queue) {
            var result = results[i];
            // If the API returns nothing then assume it's ok.
            if (result == null) {
                result = {
                    result: null,
                    stat: 'ok'
                };
            }
            if (result.stat && this._events.hasOwnProperty(result.stat)) {
                for (var b in this._events[result.stat]) {
                    this._events[result.stat][b](queue[i], result);
                }
            }
            if (result.stat && result.stat !== 'ok') {
                queue[i].deferred.reject(result);
            } else {
                queue[i].deferred.resolve(result);
            }
        }

        return results;
    };

    // Rejects all the queued promises with the provided
    // error.
    var rejectQueue = function(queue, error) {
        for (var i in queue) {
            queue[i].deferred.reject(error);
        }

        return error;
    };

    // Clears the queue of API calls and the batch timeout.
    TaggedApi.prototype.resetQueue = function() {
        if (null !== this._batchTimeout) {
            clearTimeout(this._batchTimeout);
            this._batchTimeout = null;
        }
        this._queue = [];
    };

    TaggedApi.prototype.on = function(stat, callback) {
        if (!this._events.hasOwnProperty(stat)) {
            this._events[stat] = [];
        }
        this._events[stat].push(callback);
    };

    TaggedApi.middleware = function(url, options) {
        var NodeAdapter = require('./http_adapter/node');
        var http = new NodeAdapter();

        return function(req, res, next) {
            var newOpts = {
                query: {
                    application_id: 'user',
                    format: 'JSON'
                },
                params: {
                    api_signature: ''
                },
                cookies: req.headers && req.headers.cookie,
                headers: {}
            };

            if (options && options.passHeaders) {
                for (var i = 0, j = options.passHeaders.length; i < j; i++) {
                    var header = options.passHeaders[i];
                    if (req.headers.hasOwnProperty(header)) {
                        newOpts.headers[header] = req.headers[header];
                    }
                }
            }

            req.api = new TaggedApi(url, mergeRecursive(newOpts, options || {}), http);
            next();
        };
    };

    // Transforms the post data into the format required by the API
    var stringifyQueue = function(queue) {
        // Each API call will be transformed into a string of
        // key/value pairs and placed into this array.
        var calls = [];

        for (var i in queue) {
            var call = stringifyCall(queue[i]);
            calls.push(call);
        }

        return "\n" + calls.join("\n") + "\n";
    };

    var stringifyCall = function(call) {
        // Each key/value pair of the API call will be placed
        // into this params array as a `key=value` string.
        var params = ["method=" + encodeURIComponent(call.method)];

        // Add each custom param to the params array as a
        // `key=value` string.
        for (var key in call.params) {
            // Passing `null` as a value is not supported by
            // the API, so omit those values.

            //TODO: support arrays as values
            if (null !== call.params[key] && call.params.hasOwnProperty(key)) {
                params.push(parameterize(key, call.params[key]));
            }
        }

        // All params are joined by `&`, resulting in a single
        // one-line string to represent the API call.
        return params.join('&');
    };

    var getHighResolutionTimeStamp = function() {
        if (typeof(process) !== 'undefined' && typeof process.hrtime === 'function') {
            // Node environment
            return process.hrtime();
        } else if (window && window.performance && typeof window.performance.now === 'function') {
            // Browser envorinment that supports high-resolution timestamps
            // Must convert from float to nodejs-flavored high-resolution timestamp
            // @see https://nodejs.org/api/process.html#process_process_hrtime_time
            // @see https://developer.mozilla.org/en-US/docs/Web/API/Performance/now
            var now = window.performance.now().toString();
            if (now.match(/^[0-9]+\.[0-9]+$/)) {
                return now.split('.').map(function(value) {
                    return parseInt(value);
                });
            }
        }

        // High resolution timestamps are not supported,
        // or returned an unexpected result.
        // Fall back to low-resolution timestamp.
        return [new Date().getTime(), 0];
    }

    var parameterize = function(key, value) {
        var type = typeof value;
        switch (type) {
            case 'string':
            case 'number':
            case 'boolean':
                return parameterizePrimitive(key, value);
                break;

            case 'undefined':
                return parameterizePrimitive(key, '');
                break;

            case 'object':
                // `null` is considered an "object"
                return (null === value) ? parameterizePrimitive(key, value) : parameterizeObject(key, value);
                break;

            default:
                throw new Error("Unable to parameterize key " + key + " with type " + type);
        }
    };

    var parameterizePrimitive = function(key, value) {
        // Keys and values must be encoded to
        // prevent accidental breakage of string
        // splits by `=` and `&`.
        return encodeURIComponent(key) + "=" + encodeURIComponent(value);
    };

    var parameterizeObject = function(key, value) {
        var params = [];
        if (Array.isArray(value)) {
            for (var i = 0, len = value.length; i < len; i++) {
                params.push(encodeURIComponent(key) + "[]=" + encodeURIComponent(value[i]));
            }
        } else {
            // assume object
            for (var subkey in value) {
                if (!value.hasOwnProperty(subkey)) continue;
                params.push(encodeURIComponent(key) + "[" + encodeURIComponent(subkey) + "]=" + encodeURIComponent(value[subkey]));
            }
        }

        return params.join('&');
    };

    // Recursively merge properties of two objects
    // Adapted from http://stackoverflow.com/a/383245/249394
    function mergeRecursive(obj1, obj2) {
        for (var p in obj2) {
            if (!obj2.hasOwnProperty(p)) {
                continue;
            }

            try {
                // Property in destination object set; update its value.
                if (obj2[p].constructor === Object) {
                    obj1[p] = mergeRecursive(obj1[p], obj2[p]);
                } else {
                    obj1[p] = obj2[p];
                }
            } catch(e) {
                // Property in destination object not set; create it and set its value.
                obj1[p] = obj2[p];
            }
        }

        return obj1;
    }

    if (typeof exports !== 'undefined') {
        // We're in a nodejs environment, export this module
        module.exports = TaggedApi;
    } else {
        // We're in a browser environment, expose this module globally
        context.TaggedApi = TaggedApi;
    }
})();

// This file is generally run in a browser, so wrap it in an IIFE
(function() {
    'use strict';

    var context = typeof exports !== 'undefined' ? exports : window;

    AngularAdapter.$inject = ['$http', '$window'];
    function AngularAdapter($http, $window) {
        this._$http = $http;
        this._$window = $window;
        this._timeout = 10000;
    }

    AngularAdapter.prototype.setTimeout = function(timeout) {
        this._timeout = parseInt(timeout, 10) || 10000;
    };

    AngularAdapter.prototype.post = function(req) {
        var headers = {
            'x-tagged-client-id': req.clientId,
            'x-tagged-client-url': this._$window.location.href,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest'
        };
        return this._$http.post(req.url, req.body, {
            timeout: this._timeout,
            transformResponse: transformResponse,
            headers: headers
        }).then(formatResponse);
    };

    var transformResponse = function(data) {
        // Do not deserialize the data -- let API client do that.
        // Just return the raw response body.
        return data;
    };

    var formatResponse = function(response) {
        return {
            body: response.data
        };
    };

    if (typeof exports !== 'undefined') {
        // We're in a nodejs environment, export this module (useful for unit testing)
        module.exports = AngularAdapter;
    } else {
        // We're in a browser environment, export this module globally,
        // attached to the TaggedApi module
        var TaggedApi = context.TaggedApi || {};
        TaggedApi.AngularAdapter = AngularAdapter;
    }
})();

// This file is generally run in a browser, so wrap it in an IIFE
(function() {
    'use strict';

    var wrapper = function(angular, TaggedApi) {
        // ## Module: tagged.service.api
        // Registers the module `tagged.service.api` with Angular,
        // allowing Angular apps to declare this module as a dependency.
        // This module has no depdencies of its own.
        var module = angular.module('tagged.service.api', []);

        // Register `taggedApi` as a factory,
        // which allows Angular us to return the service ourselves.
        // What we return will end up as a singleton
        // and the same instance will be passed around through the Angular app.
        module.factory('taggedApi', taggedApiFactory);

        taggedApiFactory.$inject = ['$http', '$q', '$window'];
        taggedApiFactory.timeout = 10000;
        function taggedApiFactory($http, $q, $window) {
            var angularAdapter = new TaggedApi.AngularAdapter($http, $window);

            var api = new TaggedApi('/api/', {
                query: {
                    application_id: 'user',
                    format: 'json'
                },
                clientId: this.clientId,
                timeout: this.timeout
            }, angularAdapter);

            // Wrap `execute()` in an Angular promise
            api.execute = function(method, params) {
                return $q.when(TaggedApi.prototype.execute.call(this, method, params));
            };

            return api;
        }
    };

    if (typeof exports !== 'undefined') {
        // We're in a nodejs environment, export this module
        module.exports = wrapper;
    } else {
        // We're in a browser environment, expose this module globally
        TaggedApi.angularWrapper = wrapper;
    }
})();
TaggedApi.angularWrapper(angular, TaggedApi);