import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";

import esquery from "esquery";
import { globby } from "globby";

import * as jsdocEslintParser from "@es-joy/jsdoc-eslint-parser/typescript.js";
import {
    estreeToString, jsdocVisitorKeys, jsdocTypeVisitorKeys
} from "@es-joy/jsdoccomment";

import * as escodegen from "@es-joy/escodegen";

import { builders } from "ast-types";

/**
 * @param {{includeFiles, ignoreFiles}} cfg
 * @returns {Promise<string>}
 */
async function js2tsAssistant ({
  includeFiles,
  ignoreFiles,
  customParamHandling,
  customClassHandling,
  targetDirectory = "tmp"
}) {
  if (!includeFiles && !ignoreFiles) {
    ({
        _preprocess_include: includeFiles = includeFiles,
        _preprocess_exclude: ignoreFiles = ignoreFiles
    } = JSON.parse(await readFile("tsconfig.json")));
  }

  const files = await globby(includeFiles, {
      ignoreFiles
  });

  await Promise.all(files.map(async file => {
      const contents = await readFile(file, "utf8");

      const tree = jsdocEslintParser.parseForESLint(contents, {
          mode: "typescript",
          throwOnTypeParsingErrors: true
      });

      const { visitorKeys, ast } = tree;

      const typedefSiblingsOfLocal = "JsdocTag[tag=local] ~ JsdocTag[tag=typedef]";
      const typedefs = esquery.query(ast, typedefSiblingsOfLocal, {
          visitorKeys
      });

      // Replace type shorthands with our typedef long form
      typedefs.forEach(({ name, parsedType }) => {
          const nameNodes = esquery.query(ast, `JsdocTypeName[value=${name}]`, {
              visitorKeys
          });

          // Rather than go to the trouble of splicing from a child whose index
          //   we have to work to find, just copy the keys to the existing object
          nameNodes.forEach(nameNode => {
              Object.keys(nameNode).forEach(prop => {
                  if (prop === "parent") {
                      return;
                  }
                  delete nameNode[prop];
              });
              Object.entries(parsedType).forEach(([prop, val]) => {
                  if (prop === "parent") {
                      return;
                  }
                  nameNode[prop] = val;
              });
          });
      });

      // Remove local typedefs from AST
      for (const typedef of typedefs) {
          const { tags } = typedef.parent;
          const idx = tags.indexOf(typedef);

          tags.splice(idx, 1);
      }

      // Now remove the empty locals
      const emptyLocals = esquery.query(ast, "JsdocBlock:has(JsdocTag:not([tag!=local]))", {
          visitorKeys
      });

      for (const emptyLocal of emptyLocals) {
          const idx = ast.jsdocBlocks.indexOf(emptyLocal);

          ast.jsdocBlocks.splice(idx, 1);
      }

      const exportBlocks = esquery.query(ast, "JsdocBlock:has(JsdocTag[tag=export])", {
          visitorKeys
      });

      /**
       * Build a JSDoc type cast.
       * @param {Object} extraInfo Extra type info
       * @returns {JsdocBlock} The JsdocBlock object
       */
      function typeCast(extraInfo) {
          return {
              type: "JsdocBlock",
              initial: "",
              delimiter: "/**",
              postDelimiter: "",
              terminal: "*/",
              descriptionLines: [],
              tags: [
                  {
                      type: "JsdocTag",
                      tag: "type",
                      postTag: " ",
                      descriptionLines: [],
                      ...extraInfo,
                      postType: "",
                      initial: "",
                      delimiter: "",
                      postDelimiter: " "
                  }
              ]
          };
      }

      /**
       * Build a JSDoc typedef.
       * @param {Object} extraInfo Extra type info
       * @returns {JsdocBlock} The JsdocBlock object
       */
      function buildTypedef(extraInfo) {
          return {
              type: "JsdocBlock",
              initial: "",
              delimiter: "/**",
              postDelimiter: "",
              terminal: "*/",
              descriptionLines: [],
              tags: [
                  {
                      type: "JsdocTag",
                      tag: "typedef",
                      postTag: " ",
                      descriptionLines: [],
                      ...extraInfo,
                      postType: "",
                      initial: "",
                      delimiter: "",
                      postDelimiter: " "
                  }
              ]
          };
      }

      for (const exportBlock of exportBlocks) {
          switch (exportBlock.parent.type) {
              case "ReturnStatement": {
                  const parent = exportBlock.parent.argument;

                  switch (parent.type) {
                      case "ClassExpression": {
                          const typeLines = parent.body.body.map(({
                              type, kind, key, value, computed,
                              static: statik
                          }) => {
                              if (computed) {
                                  return null;
                              }
                              const { jsdoc } = value.parent;

                              switch (type) {
                                  case "MethodDefinition": {
                                      if (kind === "constructor") {
                                        return null;
                                      }

                                      let output = (statik ? "static " : "") +
                                        key + ": (";

                                      output += jsdoc.tags.filter(
                                          tag => tag.tag === "param"
                                      ).map(
                                        tag => `${tag.name}: ${tag.rawType}`
                                      ).join(", ");

                                      const returns = jsdoc.tags.find(
                                          tag => tag.tag === "returns"
                                      );
                                      output += `) => ${returns.rawType || "void"}`;

                                      return output;
                                  } default:
                                      throw new Error(`Unknown ${type}`);
                              }
                          }).filter(Boolean);

                          let superClass = parent.superClass.name;

                          if (customClassHandling) {
                            const match = customClassHandling({
                              ast, builders, typeCast,
                              superClassName: parent.superClass.name
                            });
                            if (match) {
                              superClass = match;
                            }
                          }

                          const typedef = buildTypedef({
                            // Easier here than using any AST builders
                            type: `{\n  ${
                              typeLines.join(';\n  ')
                            }\n} & ${superClass}`,
                            postType: ' ',
                            name: parent.id.name
                          });

                          ast.body.push(typedef);

                          break;
                      } default:
                          throw new Error(`Unsupported type ${parent.type}`);
                  }

                  break;
              } default:
                  throw new Error("Currently unsupported AST export structure");
          }
      }

      const generated = escodegen.generate(ast, {
          sourceContent: contents,
          codegenFactory() {
              const { CodeGenerator } = escodegen;

              Object.keys(jsdocVisitorKeys).forEach(method => {
                  CodeGenerator.Statement[method] =
              CodeGenerator.prototype[method] = node =>

                  // We have to add our own line break, as `jsdoccomment` (nor
                  //   `comment-parser`) keep track of trailing content
                  ((
                      node.endLine ? "\n" : ""
                  ) + estreeToString(node) +
                  (node.endLine ? `\n${node.initial}` : " "));
              });

              Object.keys(jsdocTypeVisitorKeys).forEach(method => {
                  CodeGenerator.Statement[method] =
              CodeGenerator.prototype[method] = node =>
                  estreeToString(node);
              });

              return new CodeGenerator();
          }
      });

      const targetFile = join(targetDirectory, file);

      await mkdir(dirname(targetFile), { recursive: true });
      await writeFile(targetFile, generated);
  }));
}

export default js2tsAssistant;
