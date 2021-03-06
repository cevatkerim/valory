global.Promise = require("bluebird");

import {ValidatorModule} from "../compiler/compilerheaders";
import {Swagger} from "./swagger";
import {loadModule} from "../compiler/loader";
import isNil = require("lodash/isNil");
import omitBy = require("lodash/omitBy");
import omit = require("lodash/omit");
import set = require("lodash/set");
import uniq = require("lodash/uniq");
import {Steed} from "steed";
import {Logger} from "pino";
import {openSync} from "fs";
import {resolve as resolvePath} from "path";
import {ApiRequest, AttachmentKey} from "./request";
import {Config, GENROUTES_VERSION, METADATA_VERSION} from "../lib/config";
import {
	ApiExchange,
	ApiHandler,
	ApiMiddleware,
	ApiResponse,
	ApiServer,
	ErrorDef,
	ErrorFormatter,
	HttpMethod,
	VALORYLOGGERVAR,
	ValoryMetadata,
	VALORYMETAVAR,
	VALORYPRETTYLOGGERVAR,
} from "./valoryheaders";

import P = require("pino");

const steed: Steed = require("steed")();
const uuid = require("hyperid")();
const flatStr = require("flatstr");
// const steedSeries = (Promise as any).promisify(steed.eachSeries, {context: steed, multiArgs: true});

const ERRORTABLEHEADER = "|Status Code|Name|Description|\n|-|-|--|\n";
const REDOCPATH = "../../html/index.html";

const DefaultErrorFormatter: ErrorFormatter = (error, message): ApiResponse => {
	let finalMessage = (message != null) ? message : error.defaultMessage;
	if (typeof finalMessage !== "string") {
		finalMessage = "[";
		for (let i = 0; i < message.length; i++) {
			finalMessage += `"${message[i]}"`;
			if (i + 1 !== message.length) {
				finalMessage += ",";
			}
		}
		finalMessage += "]";
	} else {
		finalMessage = `"${finalMessage}"`;
	}
	return {
		statusCode: error.statusCode,
		body: flatStr(`{"code":${error.errorCode},"message":${finalMessage}}`),
		headers: {"Content-Type": "application/json"},
        disableSerializer: true,
    };
};

const DefaultErrorFormatterNoSerialization: ErrorFormatter = (error, message): ApiResponse => {
    return {
        statusCode: error.statusCode,
        body: (message != null) ? message : error.defaultMessage,
        headers: {"Content-Type": "application/json"},
		disableSerializer: true,
    };
};

export interface ValoryOptions {
	info: Swagger.Info;
	server: ApiServer;
	errors?: { [x: string]: ErrorDef };
	consumes?: string[];
	produces?: string[];
	parameters?: { [name: string]: Swagger.Parameter };
	responses?: { [name: string]: Swagger.Response };
	definitions?: { [x: string]: Swagger.Schema };
	tags?: Swagger.Tag[];
	basePath?: string;
	// compiledLibOverride?: {
	// 	generatedRoutes?: any;
	// 	compswag: ValidatorModule;
	// };
}

const DefaultErrors: { [x: string]: ErrorDef } = {
	ValidationError: {
		statusCode: 200,
		errorCode: 1001,
		defaultMessage: "Invalid Parameters",
	},
	TokenMalformed: {
		statusCode: 200,
		errorCode: 1002,
		defaultMessage: "Authorization Failure",
	},
	InternalError: {
		statusCode: 200,
		errorCode: 1003,
		defaultMessage: "An internal error occured",
	},
};

export class Valory {
	public static CompileLibOverride: {
        generatedRoutes?: any;
        compswag: ValidatorModule;
    };
	public static ValidationResultKey: AttachmentKey<true | string[] | string>
		= ApiRequest.createKey<true | string[] | string>();
	public static RequestIDKey: AttachmentKey<string> = ApiRequest.createKey<string>();
	public static ResponseKey: AttachmentKey<ApiResponse> = ApiRequest.createKey<ApiResponse>();

	/**
	 * Create the Valory instance
	 */
	public static createInstance(options: ValoryOptions): Valory {
		Valory.directInstantiation = false;
		return new Valory(options.info, options.errors || {}, options.consumes, options.produces, options.definitions || {},
			options.tags || [], options.server, options.basePath, options.parameters, options.responses);
	}

	/**
	 * Get the valory instance
	 */
	public static getInstance(): Valory {
		if (Valory.instance == null) {
			throw Error("Valory instance has not yet been created");
		}
		return Valory.instance;
	}

	private static instance: Valory;
	private static directInstantiation = true;
	public Logger = P({
		level: process.env[VALORYLOGGERVAR] || "info",
		prettyPrint: process.env[VALORYPRETTYLOGGERVAR] === "true",
	});
	private RequestLogger: Logger;
	private COMPILERMODE = process.env.VALORYCOMPILER === "TRUE";
    private TESTMODE: boolean = (process.env.TEST_MODE === "TRUE");
    private DEFAULTADAPTOR: string = process.env.DEFAULT_ADAPTOR;
    private errorFormatter: ErrorFormatter = DefaultErrorFormatter;
    private globalMiddleware: ApiMiddleware[] = [];
    private globalPostMiddleware: ApiMiddleware[] = [];
    private apiDef: Swagger.Spec;
    private validatorModule: ValidatorModule;
    private errors = DefaultErrors;
    private registerGeneratedRoutes: (app: Valory) => void;
    private metadata: ValoryMetadata = {
		metadataVersion: METADATA_VERSION,
		undocumentedEndpoints: [],
		valoryPath: __dirname,
		compiledSwaggerPath: Config.CompSwagPath,
		swagger: null,
		disableSerialization: [],
	};
    private logRequest: (req: ApiRequest, res: ApiResponse, id: string) => void = () => null;

	/**
	 * @deprecated use [[Valory.createInstance]] instead
	 */
	private constructor(info: Swagger.Info, errors: { [x: string]: ErrorDef }, consumes: string[] = [],
						produces: string[] = [], definitions: { [x: string]: Swagger.Schema }, tags: Swagger.Tag[],
						public server: ApiServer, basePath?: string, parameters: { [name: string]: Swagger.Parameter } = {},
						responses: { [name: string]: Swagger.Response } = {}) {
		Config.load(!(!this.COMPILERMODE && Valory.CompileLibOverride));
		if (Valory.instance != null) {
			throw Error("Only a single valory instance is allowed");
		}
		if (Valory.directInstantiation) {
			throw Error("Direct instantiation of valory is not allowed");
		}
		Valory.instance = this;
		this.apiDef = {
			swagger: "2.0",
			info,
			paths: {},
			definitions,
			tags,
			consumes,
			produces,
			parameters,
			responses,
		};

		if (basePath != null) {
			this.Logger.debug("Path prefix set:", basePath);
			this.apiDef.basePath = basePath;
		}

		if (this.server.disableSerialization) {
			this.setErrorFormatter(DefaultErrorFormatterNoSerialization);
		}

		Object.assign(this.errors, errors);
		if (!this.COMPILERMODE) {
			if (process.env.REQUEST_AUDIT_LOG) {
				try {
					const stream = openSync(process.env.REQUEST_AUDIT_LOG, "w");
					this.RequestLogger = P((P as any).extreme(stream));
					this.logRequest = (req, res, id) => {
						this.RequestLogger.info({request: req, response: res, id});
					};
					this.Logger.info(`Request logging enabled: ${resolvePath(process.env.REQUEST_AUDIT_LOG)}`);
				} catch (e) {
					throw Error("Could not create write stream for request audit log: " + e.message);
                }
			}

			this.Logger.info("Starting valory");

			if (this.TESTMODE) {
				this.server = new (require(this.DEFAULTADAPTOR)).DefaultAdaptor();
			}
			if (Config.SourceRoutePath !== "" || Valory.CompileLibOverride) {
				let genRoutes: any;
				if (Valory.CompileLibOverride != null && Valory.CompileLibOverride.generatedRoutes != null) {
					genRoutes = Valory.CompileLibOverride.generatedRoutes;
				} else {
					genRoutes = require(Config.GeneratedRoutePath);
				}
				if (genRoutes.genroutesVersion !== GENROUTES_VERSION) {
					throw Error(
						`Generated routes are version ${genRoutes.genroutesVersion} but version ${GENROUTES_VERSION} is required`);
				}
				Object.assign(this.apiDef.definitions, genRoutes.definitions);
				this.registerGeneratedRoutes = genRoutes.register;
			}
			if (Valory.CompileLibOverride != null) {
				this.validatorModule = Valory.CompileLibOverride.compswag;
			} else {
				this.validatorModule = loadModule(definitions);
			}
			if (this.server.allowDocSite) {
				this.registerDocSite();
			}
		} else {
			this.Logger.debug("Starting in compiler mode");
			this.apiDef.tags.push(generateErrorTable(this.errors));
			// console.log(Config);
			if (Config.SourceRoutePath !== "") {
				const genRoutes = require(Config.SourceRoutePath);
                if (genRoutes.genroutesVersion !== GENROUTES_VERSION) {
                    // tslint:disable-next-line:max-line-length
                	throw Error(`Generated routes are version ${genRoutes.genroutesVersion} but version ${GENROUTES_VERSION} is required`);
                }
				Object.assign(this.apiDef.definitions, genRoutes.definitions);
				this.registerGeneratedRoutes = genRoutes.register;
			}
		}
	}

	/**
	 * Register an endpoint with a given method
	 */
	public endpoint(path: string, method: HttpMethod, swaggerDef: Swagger.Operation, handler: ApiHandler,
					middleware: ApiMiddleware[] = [], documented: boolean = true, postMiddleware: ApiMiddleware[] = [],
					disableSerializer: boolean = true) {
		const stringMethod = HttpMethod[method].toLowerCase();
		this.Logger.debug(`Registering endpoint ${this.apiDef.basePath || ""}${path}:${stringMethod}`);
		if (this.COMPILERMODE) {
			this.endpointCompile(path, method, swaggerDef, handler, stringMethod,
				middleware, documented, postMiddleware, disableSerializer);
		} else {
			this.endpointRun(path, method, swaggerDef, handler, stringMethod,
				middleware, documented, postMiddleware, disableSerializer);
		}
	}

	/**
	 * Override the default error formatter
	 */
	public setErrorFormatter(formatter: ErrorFormatter) {
		this.errorFormatter = formatter;
	}

	/**
	 * Build an ApiExchange from either an error name or an ErrorDef
	 */
	public buildError(error: string | ErrorDef, message?: string | string[]): ApiResponse {
		const errorDef: ErrorDef = (typeof error === "string") ? this.errors[error] : error;
		if (errorDef == null) {
			throw Error(`Error definition "${error}" does not exist`);
		}
		return this.errorFormatter(errorDef, message);
	}

	/**
	 * Convenience method to build a return exchange when only body and/or header customization is required
	 */
	public buildSuccess(body: any, headers: { [key: string]: any } = {}, statusCode = 200,
						disableSerializer: boolean = false): ApiResponse {
		if (headers["Content-Type"] == null) {
			if (typeof body === "object") {
				headers["Content-Type"] = "application/json";
			} else if (typeof body === "string") {
				headers["Content-Type"] = "text/plain";
			}
		}
		return {
			body,
			headers,
			statusCode,
			disableSerializer,
		};
	}

	/**
	 * Register GET endpoint
	 */
	public get(path: string, swaggerDef: Swagger.Operation, handler: ApiHandler, middleware: ApiMiddleware[] = [],
			   documented: boolean = true, postMiddleware: ApiMiddleware[] = [], disableSerializer: boolean = true) {
		this.endpoint(path, HttpMethod.GET, swaggerDef, handler, middleware, documented, postMiddleware, disableSerializer);
	}

	/**
	 * Register POST endpoint
	 */
	public post(path: string, swaggerDef: Swagger.Operation, handler: ApiHandler, middleware: ApiMiddleware[] = [],
				documented: boolean = true, postMiddleware: ApiMiddleware[] = [], disableSerializer: boolean = true) {
		this.endpoint(path, HttpMethod.POST, swaggerDef, handler, middleware, documented, postMiddleware, disableSerializer);
	}

	/**
	 * Register DELETE endpoint
	 */
	public delete(path: string, swaggerDef: Swagger.Operation, handler: ApiHandler, middleware: ApiMiddleware[] = [],
				  documented: boolean = true, postMiddleware: ApiMiddleware[] = [], disableSerializer: boolean = true) {
		this.endpoint(path, HttpMethod.DELETE, swaggerDef, handler, middleware, documented, postMiddleware,
			disableSerializer);
	}

	/**
	 * Register HEAD endpoint
	 */
	public head(path: string, swaggerDef: Swagger.Operation, handler: ApiHandler, middleware: ApiMiddleware[] = [],
				documented: boolean = true, postMiddleware: ApiMiddleware[] = [], disableSerializer: boolean = true) {
		this.endpoint(path, HttpMethod.HEAD, swaggerDef, handler, middleware, documented, postMiddleware, disableSerializer);
	}

	/**
	 * Register PATCH endpoint
	 */
	public patch(path: string, swaggerDef: Swagger.Operation, handler: ApiHandler, middleware: ApiMiddleware[] = [],
				 documented: boolean = true, postMiddleware: ApiMiddleware[] = [], disableSerializer: boolean = true) {
		this.endpoint(path, HttpMethod.PATCH, swaggerDef, handler, middleware, documented, postMiddleware, disableSerializer);
	}

	/**
	 * Register PUT endpoint
	 */
	public put(path: string, swaggerDef: Swagger.Operation, handler: ApiHandler, middleware: ApiMiddleware[] = [],
			   documented: boolean = true, postMiddleware: ApiMiddleware[] = [], disableSerializer: boolean = true) {
		this.endpoint(path, HttpMethod.PUT, swaggerDef, handler, middleware, documented, postMiddleware, disableSerializer);
	}

	/**
	 * Register a global middleware run before every endpoint
	 */
	public addGlobalMiddleware(middleware: ApiMiddleware) {
		this.Logger.debug("Adding global middleware:", middleware.name);
		this.globalMiddleware.push(middleware);
	}

	/**
	 * Register a global post middleware run after every endpoint
	 */
	public addGlobalPostMiddleware(middleware: ApiMiddleware) {
		this.Logger.debug("Adding global post middleware:", middleware.name);
		this.globalPostMiddleware.push(middleware);
	}

	/**
	 * Start server. Call once all endpoints are registered.
	 */
	public start(options: any): any {
		if (this.registerGeneratedRoutes != null) {
			this.registerGeneratedRoutes(this);
		}
		this.metadata.swagger = this.apiDef;
		const data = this.server.getExport(this.metadata, options);
		if (this.COMPILERMODE) {
			process.env[VALORYMETAVAR] = JSON.stringify(data);
		}
		if (!this.COMPILERMODE) {
			this.Logger.info("Valory startup complete");
		}
		return data;
	}

	/**
	 * Shuts down the server core
	 */
	public shutdown() {
		this.server.shutdown();
	}

	private endpointCompile(path: string, method: HttpMethod, swaggerDef: Swagger.Operation, handler: ApiHandler,
							stringMethod: string, middleware: ApiMiddleware[] = [], documented: boolean = true,
							postMiddleware: ApiMiddleware[] = [], disableSerializer: boolean = true) {
		const middlewares: ApiMiddleware[] = this.globalMiddleware.concat(middleware,
			this.globalPostMiddleware, postMiddleware);
        if (!documented) {
            this.metadata.undocumentedEndpoints.push(path);
        }
        if (disableSerializer) {
        	this.metadata.disableSerialization.push(`${path}:${HttpMethod[method].toLowerCase()}`);
		}
		for (const item of middlewares) {
			if (item.tag != null) {
				if (!(item.tag instanceof Array)) {
					item.tag = [item.tag];
				}
				for (const def of (item.tag as Array<string | Swagger.Tag>)) {
					let tag = "";
					if (typeof def === "string") {
						tag = def;
					} else {
						this.apiDef.tags.push(def);
						tag = def.name;
					}
					(swaggerDef.tags == null) ? swaggerDef.tags = [tag] : swaggerDef.tags.push(tag);
				}
			}
		}
		swaggerDef.tags = uniq(swaggerDef.tags);
		this.apiDef.tags = uniq(this.apiDef.tags);
		set(this.apiDef.paths, `${path}.${stringMethod}`, swaggerDef);
	}

	private endpointRun(path: string, method: HttpMethod, swaggerDef: Swagger.Operation,
						handler: ApiHandler, stringMethod: string, middleware: ApiMiddleware[] = [],
						documented: boolean = true, postMiddleware: ApiMiddleware[] = [], disableSerializer: boolean = true) {
		const validator = this.validatorModule.getValidator(path, stringMethod);
		if (this.server.disableSerialization) {
			validator.serializer = (a: any) => a;
		}

		if (this.apiDef.basePath != null) {
			path = this.apiDef.basePath + path;
		}
		if (validator == null) {
			throw Error("Compiled swagger is out of date. Please run valory cli");
		}
		const route = `${path}:${stringMethod}`;
		const childLogger = this.Logger.child({endpoint: route});
		const middlewares: ApiMiddleware[] = this.globalMiddleware.concat(middleware);
		const postMiddlewares = this.globalPostMiddleware.concat(postMiddleware);
		const middlewareProcessor = (middlewares.length > 0) ? processMiddleware : noopPromise;
		const postMiddlewareProcessor = (postMiddlewares.length > 0) ? processMiddleware : noopPromise;
		const logRequest = this.logRequest;
		const wrapper = (req: ApiRequest): Promise<ApiResponse> => {
			const requestId = uuid();
			req.putAttachment(Valory.RequestIDKey, requestId);
			const requestLogger = childLogger.child({requestId});
			requestLogger.debug("Received request");
			let initialResponse: ApiResponse = null;
			let handlerResponded = false;
			return middlewareProcessor(middlewares, req, requestLogger).then((middlewareResp) => {
                if (middlewareResp != null) {
                    return Promise.resolve(middlewareResp);
                }
                const result = validator.validator(req);
                req.putAttachment(Valory.ValidationResultKey, result);
                if (result !== true) {
                    return Promise.resolve(this.buildError("ValidationError", result as string[]));
                } else {
                	handlerResponded = true;
                    return Promise.resolve(handler(req, requestLogger, {requestId}));
                }
			}).catch((error) => {
				handlerResponded = false;
                if (error.name === "ValoryEndpointError") {
                    return this.buildError(error.valoryErrorCode, error.message || undefined);
                }
                requestLogger.error("Internal exception occurred while processing request");
                requestLogger.error(error);
                return Promise.resolve(this.buildError("InternalError"));
			}).then((response: ApiResponse) => {
                req.putAttachment(Valory.ResponseKey, response);
                initialResponse = response;
                return postMiddlewareProcessor(postMiddlewares, req, requestLogger);
			}).then((response) => {
				logRequest(req, response || initialResponse, requestId);
				if (response != null) {
					return (response as ApiResponse);
				}
				if (handlerResponded && !initialResponse.disableSerializer) {
                    try {
                        initialResponse.body = flatStr(validator.serializer(initialResponse.body));
                    } catch (e) {
                    	requestLogger.error(e, "Failed to serialize response");
                    	return this.buildError("InternalError");
                    }
                }
				return initialResponse;
			}).catch((error) => {
                requestLogger.error("Internal exception occurred while processing request");
                requestLogger.error(error);
				return this.buildError("InternalError");
			}).then((res: ApiResponse) => {
				res.headers["request-id"] = requestId;
				return res;
			});
		};
		this.server.register(path, method, wrapper);
	}

	private registerDocSite() {
		const prefix = this.apiDef.basePath || "";
		let swaggerBlob: Swagger.Spec;
		this.server.register(prefix + "/swagger.json", HttpMethod.GET, (req) => {
			if (swaggerBlob == null) {
				swaggerBlob = JSON.parse(this.validatorModule.swaggerBlob);
				swaggerBlob.paths = omit(swaggerBlob.paths, this.metadata.undocumentedEndpoints);
			}
			return Promise.resolve({
				body: JSON.stringify(swaggerBlob),
				headers: {"Content-Type": "text/plain"},
				query: null,
				path: null,
				statusCode: 200,
				formData: null,
			});
		});
		this.server.register((prefix !== "") ? prefix : "/", HttpMethod.GET, (req) => {
			return Promise.resolve({
				body: Config.DOC_HTML,
				headers: {"Content-Type": "text/html"},
				query: null,
				path: null,
				statusCode: 200,
				formData: null,
			});
		});
	}
}

function noopPromise(...args: any[]) {
	return Promise.resolve();
}

function processMiddleware(middlewares: ApiMiddleware[],
						   req: ApiRequest, logger: Logger): Promise<void | ApiResponse> {
    return new Promise<void | ApiResponse>((resolve) => {
        let err: ApiExchange = null;
        steed.eachSeries(middlewares, (handler: ApiMiddleware, done) => {
        	if ((handler as any).logger == null) {
				(handler as any).logger = logger.child({middleware: handler.name});
			}
			(handler as any).logger.debug("Running Middleware");
            handler.handler(req, (handler as any).logger, (error) => {
                if (error != null) {
                    err = error;
                    done(error);
                    return;
                }

                done();
            });
        }, (error) => {
            resolve(err as ApiResponse);
        });
    });
}

function generateErrorTable(errors: { [x: string]: ErrorDef }): Swagger.Tag {
	const tagDef: Swagger.Tag = {name: "Errors", description: "", externalDocs: null};
	let table = ERRORTABLEHEADER;
	const keys = Object.keys(errors);
	keys.sort((a, b) => {
		const aCode = errors[a].errorCode;
		const bCode = errors[b].errorCode;

		if (aCode < bCode) {
			return -1;
		}
		if (aCode === bCode) {
			return 0;
		}
		if (aCode > bCode) {
			return 1;
		}
	});

	for (const name of keys) {
		const error = errors[name];
		table += "|" + error.errorCode + "|" + name + "|" + error.defaultMessage + "|\n";
	}
	tagDef.description = table;
	return omitBy(tagDef, isNil) as Swagger.Tag;
}
