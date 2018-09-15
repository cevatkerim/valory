import {
    ApiRequest,
    Body,
    Header,
    Post,
    Route,
    Request,
    Controller,
    Logger,
    Middleware,
    ApiMiddleware,
    Valory, ApiError, Hidden, Query, PostMiddleware, Get, Path, BodyProp,
} from "../main";

export interface TestResponse<T> {
    status_code: number;
    /** @default test */
    response_data: T;
}

export class Burn {
    /** @minLength 3 */
    public name: string = "steven";
    public content: string;
    public powerlevel?: number;
    public array: ArrayAlias;
    public string: StringAlias;
    public alias: AliasAlias;
    public literalEnum: LiteralEnum;
    public literal: LiteralAlias;
    public literalNum: LiteralNum;
}

export type ArrayAlias = number[];
// export type TupleAlias = [number, number];
/**
 * alias to a string
 * @example "a string"
 * @minLength 3
 */
export type StringAlias = string;
export type AliasAlias = StringAlias;
export type LiteralAlias = "test";
export type LiteralEnum = "thing" | "otherthing";
export type LiteralNum = 2;

export class TestObj {
    /**
     * @example "nested example"
     */
    public thing: string;
    public otherThing: number;
    public nested: {
        /**
         * nestedprop description
         * @example "nested prop exmaple"
         */
        nestedProp: string;
        nestedObj: {
            num: number;
        };
    };
}

export interface SimpleExampleTest {
    /**
     * @example 34
     */
    test: number;
}

const TestMiddleware: ApiMiddleware = {
    tag: {
        name: "GTFO",
        description: "Access denied on this resource",
    },
    name: "TestMiddleware",
    handler: (req, logger, done) => {
        done({statusCode: 333, headers: {}, body: req.getAttachment(Valory.ResponseKey)});
    },
};

/**
 * Parent type description
 */
export type ParentType = ChildType | OtherChildType;

export type ImpostorType = ChildType | OtherChildType;

/**
 * ChildType description
 */
export interface ChildType {
    dtype: "ChildType";
    /**
     * @example "joe"
     */
    thing: string;
}

export interface OtherChildType {
    dtype: "OtherChildType";
    other: number;
}

export interface ApiRes<T> {
    status_code: 1;
    response_data: T;
}

export type ApiResAsync<T> = Promise<ApiRes<T>>;

export interface NestedGeneric<T> {
    data: ApiRes<T>;
}

@Route("burn")
export class BurnRoutes extends Controller {

    /**
     *
     * @param thing test
     */
    @Post("other/{thing}")
    public test(@Path() thing: string, @Body() input: ParentType): ApiRes<string> {
        return {status_code: 1, response_data: "yay"};
    }
}

@Route("thing")
export class ThingRoutes extends Controller {
    // @PostMiddleware(TestMiddleware)
    @Get()
    public yay() {
        return "yay";
    }

    @Post("other")
    public test(@Body() input: ImpostorType): ApiRes<string> {
        return {status_code: 1, response_data: "yay"};
    }
}

type func = (test: string) => number;
