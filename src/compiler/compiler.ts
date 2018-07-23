import {cloneDeep, merge} from "lodash";
import {dereference, validate} from "swagger-parser";
import {mangleKeys, resolve, schemaPreprocess, swaggerPreproccess} from "./preprocessor";
import {compileMethodSchema} from "./method";
import * as Ajv from "ajv";
import * as fs from "fs";
import {
	CompilationLevel,
	CompilerOutput,
	FUNCTION_PREFIX,
	HASH_SEED,
	ICompilerOptions,
	ValidatorModuleContent,
} from "./compilerheaders";
import {join} from "path";
import {VALORYPRETTYLOGGERVAR} from "../server/valory";
import Pino = require("pino");
import {convertTime} from "../lib/helpers";
import {Swagger} from "../server/swagger";
import {Config} from "../lib/config";
import chalk from "chalk";

export const CompileLog = Pino({prettyPrint: process.env[VALORYPRETTYLOGGERVAR] === "true"});
const beautifier = require("js-beautify").js_beautify;
const ClosureCompiler = require("google-closure-compiler").compiler;
const tmp = require("tmp");
const dotJs = require("dot");
dotJs.log = false;
const templates = dotJs.process({path: join(__dirname, "../../templates")});
const errorSup = "undefinedVars";
const XXH = require("xxhashjs");

export const DisallowedFormats = ["float", "double", "int32", "int64", "byte", "binary"];

// TODO: Fix discriminator errors
export async function compile(spec: Swagger.Spec, options?: ICompilerOptions) {
	
	const output: CompilerOutput = {
		module: null,
		debugArtifacts: {
			hashes: [],
			preSwagger: null,
			derefSwagger: null,
			initialSchema: [],
			processedSchema: [],
			initialCompiles: [],
			mangledSchema: [],
			intermediateFunctions: [],
			intermediateModule: null,
			postCompileModule: null,
			closureOutput: {
				exitCode: null,
				stderr: null,
				stdout: null,
			},
		},
	};

	const defaultCompilerOptions: ICompilerOptions = {
		requestFieldMapping: {
			body: "body",
			formData: "formData",
			header: "headers",
			path: "path",
			query: "query",
		},
		debug: false,
		singleError: true,
		compilationLevel: CompilationLevel.ADVANCED,
		discrimFastFail: false,
	};

	merge(defaultCompilerOptions, options);
	options = defaultCompilerOptions;
	const ajv = new Ajv({
		coerceTypes: true,
		useDefaults: "shared",
		sourceCode: true,
		errorDataPath: "property",
		unicode: false,
		allErrors: !options.singleError,
	});
	if (options.discrimFastFail) {
		CompileLog.warn("discriminator fast fail is enabled EXPERIMENTAL");
	}
	const spinner = Config.Spinner;
	// const start = process.hrtime();
	console.log(chalk.bold("Prepare Swagger"));
	// CompileLog.info("Validating swagger");
	await spinner.start("Validating Swagger");
	await validate(cloneDeep(spec as any));
	await spinner.succeed();
	// CompileLog.info("Preprocessing swagger");
	spinner.start("Preprocessing Swagger");
	output.debugArtifacts.preSwagger = swaggerPreproccess(cloneDeep(spec as any));
	await spinner.succeed();
	spinner.start("Dereferencing Swagger");
	output.debugArtifacts.derefSwagger = await dereference(output.debugArtifacts.preSwagger.swagger as any);
	await spinner.succeed();
	console.log(chalk.bold("Build Endpoints"));
	for (const path of Object.keys(output.debugArtifacts.derefSwagger.paths)) {
		for (const method of Object.keys(output.debugArtifacts.derefSwagger.paths[path])) {
			await spinner.start("Building method schema");
			const hash = FUNCTION_PREFIX + XXH.h32(`${path}:${method}`, HASH_SEED).toString();
			const endpointLogger = CompileLog.child({endpoint: `${path}:${method}`, hash});
			// endpointLogger.info("Building method schema");
			const schema = compileMethodSchema((output.debugArtifacts.derefSwagger.paths[path] as any)[method], method, path,
				options.requestFieldMapping);
			spinner.text = "Preprocessing schema";
			const schemaProcessed = schemaPreprocess(schema);
			spinner.text = "Compiling schema validator";
			const initialCompile = ajv.compile(schemaProcessed.schema);
			spinner.text = "Objectifying anyOf's";
			resolve(schemaProcessed.resQueue);
			spinner.text = "Mangling keys";
			const mangled = mangleKeys(schemaProcessed.schema);
			spinner.text = "Compiling intermediate validator function";
			const templated = templates.validatorTemplate({
				validate: initialCompile,
				funcName: path,
				localConsumes: (output.debugArtifacts.derefSwagger.paths[path] as any)[method].consumes,
				hash,
				format: (ajv as any)._opts.format,
				mangledKeys: mangled.mangledKeys,
				schema: mangled.schema,
				singleError: options.singleError,
				discriminators: output.debugArtifacts.preSwagger.discriminators,
				discrimFastFail: options.discrimFastFail,
			});
			output.debugArtifacts.hashes.push(hash);
			output.debugArtifacts.initialSchema.push(schema);
			output.debugArtifacts.intermediateFunctions.push(templated);
			output.debugArtifacts.processedSchema.push(schemaProcessed.schema);
			output.debugArtifacts.initialCompiles.push(initialCompile);
			output.debugArtifacts.mangledSchema.push(mangled);
			await spinner.succeed(`${path}:${method}`);
		}
	}
	console.log(chalk.bold("Compile"));
	await spinner.start("Building intermediate module");
	output.debugArtifacts.intermediateModule = beautifier(templates.moduleTemplate({
		validatorLib: output.debugArtifacts.intermediateFunctions,
		defHash: XXH.h32(JSON.stringify(spec.definitions), HASH_SEED).toString(),
		exportHashes: output.debugArtifacts.hashes,
		swagger: spec,
	}));

	const intermediateTemp = tmp.fileSync({prefix: "valCI"});
	fs.writeSync(intermediateTemp.fd, output.debugArtifacts.intermediateModule);
	const outputTemp = tmp.fileSync({prefix: "valC"});

	const compilerFlags = {
		js: intermediateTemp.name,
		rewrite_polyfills: false,
		compilation_level: CompilationLevel[options.compilationLevel],
		use_types_for_optimization: true,
		preserve_type_annotations: true,
		js_output_file: outputTemp.name,
		language_out: "ES5_STRICT",
		debug: options.debug,
		jscomp_off: errorSup,
	};
	await spinner.succeed();
	await spinner.start("Running Closure Compiler: " + CompilationLevel[options.compilationLevel]);
	await new Promise((resol, reject) => {
		new ClosureCompiler(compilerFlags).run((exitCode: number, stdout: string, stderr: string) => {
			output.debugArtifacts.closureOutput.stderr = stderr;
			output.debugArtifacts.closureOutput.stdout = stdout;
			output.debugArtifacts.closureOutput.exitCode = exitCode;

			if (!exitCode) {
				output.debugArtifacts.postCompileModule =
					fs.readFileSync(outputTemp.name, {encoding: "utf8"}) as ValidatorModuleContent;
				resol();
			} else {
				reject(stderr);
			}
		});
	});
	await spinner.succeed();
	await spinner.start("Final post process");
	output.module = finalProcess(output.debugArtifacts.postCompileModule);
	await spinner.succeed();
	// console.log("\nDone", (convertTime(process.hrtime(start)) / 1000).toFixed(3) + "s");
	return output;
}

function finalProcess(content: ValidatorModuleContent): ValidatorModuleContent {
	"use strict";
	const trueReg = /!0/g;
	const falseReg = /!1/g;
	const nullReg = /void 0/g;
	const arrayify = /([a-zA-Z]*?)=[\S\n\r]*?\"([a-zA-Z ]+?)\".split\(\" \"\)/gm;
	// const arrayCheckReg = /Array.isArray\(([a-zA-Z]*?)\)/g;

	let ret = content.replace(trueReg, " true");
	ret = ret.replace(falseReg, " false");
	ret = ret.replace(nullReg, "undefined");
	ret = ret.replace(arrayify, (match, varName, value) => {
		return `${varName}=${JSON.stringify(value.split(" "))}`;
	});
	// ret = ret.replace(arrayCheckReg,"($1 instanceof Array)");

	return ret;
}
