# js2ts-assistant

In order to overcome a few current limitations in TypeScript's allowances for
plain JavaScript being converted to declaration files, this package offers
handling to  improve the process in a few limited cases.

1. Supports a custom `@local` tag to add to `@typdef` blocks to ensure such
    blocks are not exported (and one can thus use them for aliasing long
    types, keeping one's JSDoc easier to read). Workaround for
    [TS #22160](https://github.com/microsoft/TypeScript/issues/22160).
2. Support creation of a class skeleton (so that the class type can be
    targeted externally) when one wishes to export the class type but the
    code is not doing so (e.g., because the class is built dynamically and
    returned by a public function), one can overcome the limitation that
    TypeScript only exports the actual public exports in the case of classes.
    Workaround for
    [TS #22126](https://github.com/Microsoft/TypeScript/issues/22126)

Note that for class building, this is currently limited to returns of a certain
subset of class expressions. You can supply your own `customClassHandling`
and/or `customParamHandling` to customize the building process further (as may
be necessary in some cases where the limited approach we are using doesn't
track types throughout the project and might not be readily detectable no
matter the approach). See the source for more.

## Install

```shell
npm install -D @es-joy/js2ts-assistant
```

## API

```js
async function js2tsAssistant ({
  // Defaults to `_preprocess_include` value in `tsconfig.json`
  includeFiles,

  // Defaults to `_preprocess_exclude` value in `tsconfig.json`
  ignoreFiles,

  // Passed: `tag`, `identifier`, `typeCast`; Defaults to `undefined`
  customParamHandling,

  // Passed: `ast`, `builders`, `superClassName`; Defaults to `undefined`
  customClassHandling,

  // Where the files will be built (and can be targeted by tsc)
  targetDirectory = "tmp"
}) {
}
```

## Inner workings

We use `@es-joy/jsdoc-eslint-parser/typescript.js` to parse JavaScript with
JSDoc blocks treated as regular AST nodes. This allows us to then use `esquery`
to quickly find the tags of interest to us.

In the case of building our dummy class, we use `builders` from `ast-types`
to cleanly build our desired AST.

Then after modifications have been made, we use a light, jsdoc-comment-aware
fork of `escodegen`, `@es-joy/escodegen`, along with stringification of
`@es-joy/jsdoccomment` to convert the modified JS+JSDoc back to a string
for saving to a file (which can then be processed by `tsc`).
