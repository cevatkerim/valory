import {Swagger} from "../../server/swagger";

export namespace Tsoa {
	export interface Metadata {
		controllers: Controller[];
		referenceTypeMap: ReferenceTypeMap;
	}

	export interface Controller {
		location: string;
		methods: Method[];
		name: string;
		path: string;
		extendsController: boolean;
		disableSerialization: boolean;
		isHidden: boolean;
	}

	export interface Method {
		deprecated?: boolean;
		description?: string;
		method: "get" | "post" | "put" | "delete" | "options" | "head" | "patch";
		name: string;
		parameters: Parameter[];
		path: string;
		type: Type;
		tags?: string[];
		responses: Response[];
		security: Security[];
		summary?: string;
		isHidden: boolean;
        disableSerialization: boolean;
	}

	export interface Parameter {
		parameterName: string;
		description?: string;
		in: "query" | "header" | "path" | "formData" | "body" | "body-prop" | "request" | "logger";
		name: string;
		required?: boolean;
		type: Type;
		default?: any;
		validators: Validators;
	}

	export interface Validators {
		[key: string]: { value?: any, errorMsg?: string };
	}

	export interface Security {
		name: string;
		scopes?: string[];
	}

	export interface Response {
		description: string;
		name: string;
		schema?: Type;
		examples?: any;
	}

	export interface Property {
		default?: any;
		description?: string;
		example?: string;
		format?: string;
		name: string;
		type: Type;
		required: boolean;
		validators: Validators;
	}

	export interface Type {
		dataType: "string" | "double" | "float" | "integer" | "long" | "enum" | "array" |
			"datetime" | "date" | "buffer" | "void" | "object" | "any" | "refEnum" | "refObject" | "refAlias";
	}

	export interface EnumerateType extends Type {
		dataType: "enum";
		enums: string[];
	}

	export interface ObjectType extends Type {
		dataType: "object";
		example?: any;
		description?: string;
		properties?: Property[];
		additionalProperties?: Type;
	}

	export interface ArrayType extends Type {
		dataType: "array";
		elementType: Type;
	}

	export interface ReferenceAlias extends Type {
		description?: string;
		dataType: "refAlias";
		refName: string;
		example?: any;
		additionalSwagger?: Swagger.Schema;
		validators: Validators;
		type: Type;
		format?: string;
		properties?: Property[];
		additionalProperties?: Type;
	}

	export interface ReferenceType extends Type {
		description?: string;
		dataType: "refObject" | "refEnum";
		refName: string;
		properties?: Property[];
		additionalProperties?: Type;
		enums?: string[];
		example?: any;
		allOf?: ReferenceType[];
		discriminator?: string;
		additionalSwagger?: Swagger.Schema;
	}

	export interface ReferenceTypeMap {
		[refName: string]: Tsoa.ReferenceType | Tsoa.ReferenceAlias;
	}
}
