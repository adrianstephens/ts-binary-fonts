import eslint from "@eslint/js";
import tslint from "typescript-eslint";
async function maybeImport(modulePath) { try { return await import(modulePath); } catch { return undefined; } }
let customPlugin = await maybeImport('../eslint-custom.mjs');
// @ts-check

export default tslint.config(
    eslint.configs.recommended,
    ...tslint.configs.recommended,
    ...tslint.configs.stylistic,
	...(customPlugin ? [customPlugin.config] : []),
    {
        rules: {
                        "semi": ["error", "always"], // Add this line to enforce semicolon use
            "no-empty": "off",
            "@typescript-eslint/no-duplicate-enum-values": "off",
            "@typescript-eslint/no-empty-object-type": "off",
            //"@typescript-eslint/no-misleading-character-class": "off",
            //"@typescript-eslint/no-this-alias": "off",
            "@typescript-eslint/no-unused-vars":  [
                "warn", {
                    argsIgnorePattern: "^(_+$|_[^_])",
                    varsIgnorePattern: "^(_+$|_[^_])",
                },
            ],
            "@typescript-eslint/no-explicit-any": "off",
            //"@typescript-eslint/explicit-module-boundary-types": "off",
            //"@typescript-eslint/no-non-null-assertion": "off"
	        "@typescript-eslint/no-empty-function": "off",
            "@typescript-eslint/consistent-indexed-object-style": "off",
            "@typescript-eslint/consistent-type-definitions": "off",
"no-restricted-syntax": [
                "error",
                {
                    "selector": "Identifier[name='await']",
                    "message": "'await' is a reserved word."
                },
                {
                    "selector": "Identifier[name='break']",
                    "message": "'break' is a reserved word."
                },
                {
                    "selector": "Identifier[name='case']",
                    "message": "'case' is a reserved word."
                },
                {
                    "selector": "Identifier[name='catch']",
                    "message": "'catch' is a reserved word."
                },
                {
                    "selector": "Identifier[name='class']",
                    "message": "'class' is a reserved word."
                },
                {
                    "selector": "Identifier[name='const']",
                    "message": "'const' is a reserved word."
                },
                {
                    "selector": "Identifier[name='continue']",
                    "message": "'continue' is a reserved word."
                },
                {
                    "selector": "Identifier[name='debugger']",
                    "message": "'debugger' is a reserved word."
                },
                {
                    "selector": "Identifier[name='default']",
                    "message": "'default' is a reserved word."
                },
                {
                    "selector": "Identifier[name='delete']",
                    "message": "'delete' is a reserved word."
                },
                {
                    "selector": "Identifier[name='do']",
                    "message": "'do' is a reserved word."
                },
                {
                    "selector": "Identifier[name='else']",
                    "message": "'else' is a reserved word."
                },
                {
                    "selector": "Identifier[name='enum']",
                    "message": "'enum' is a reserved word."
                },
                {
                    "selector": "Identifier[name='export']",
                    "message": "'export' is a reserved word."
                },
                {
                    "selector": "Identifier[name='extends']",
                    "message": "'extends' is a reserved word."
                },
                {
                    "selector": "Identifier[name='false']",
                    "message": "'false' is a reserved word."
                },
                {
                    "selector": "Identifier[name='finally']",
                    "message": "'finally' is a reserved word."
                },
                {
                    "selector": "Identifier[name='for']",
                    "message": "'for' is a reserved word."
                },
                {
                    "selector": "Identifier[name='function']",
                    "message": "'function' is a reserved word."
                },
                {
                    "selector": "Identifier[name='if']",
                    "message": "'if' is a reserved word."
                },
                {
                    "selector": "Identifier[name='import']",
                    "message": "'import' is a reserved word."
                },
                {
                    "selector": "Identifier[name='in']",
                    "message": "'in' is a reserved word."
                },
                {
                    "selector": "Identifier[name='instanceof']",
                    "message": "'instanceof' is a reserved word."
                },
                {
                    "selector": "Identifier[name='let']",
                    "message": "'let' is a reserved word."
                },
                {
                    "selector": "Identifier[name='new']",
                    "message": "'new' is a reserved word."
                },
                {
                    "selector": "Identifier[name='null']",
                    "message": "'null' is a reserved word."
                },
                {
                    "selector": "Identifier[name='return']",
                    "message": "'return' is a reserved word."
                },
                {
                    "selector": "Identifier[name='super']",
                    "message": "'super' is a reserved word."
                },
                {
                    "selector": "Identifier[name='switch']",
                    "message": "'switch' is a reserved word."
                },
                /*{
                    "selector": "Identifier[name='this']",
                    "message": "'this' is a reserved word."
                },*/
                {
                    "selector": "Identifier[name='throw']",
                    "message": "'throw' is a reserved word."
                },
                {
                    "selector": "Identifier[name='true']",
                    "message": "'true' is a reserved word."
                },
                {
                    "selector": "Identifier[name='try']",
                    "message": "'try' is a reserved word."
                },
                {
                    "selector": "Identifier[name='typeof']",
                    "message": "'typeof' is a reserved word."
                },
                {
                    "selector": "Identifier[name='var']",
                    "message": "'var' is a reserved word."
                },
                {
                    "selector": "Identifier[name='void']",
                    "message": "'void' is a reserved word."
                },
                {
                    "selector": "Identifier[name='while']",
                    "message": "'while' is a reserved word."
                },
                {
                    "selector": "Identifier[name='with']",
                    "message": "'with' is a reserved word."
                },
                {
                    "selector": "Identifier[name='yield']",
                    "message": "'yield' is a reserved word."
                },
            ]
        },
    },
    {
        files: ["src/*.ts"],
    }
);
