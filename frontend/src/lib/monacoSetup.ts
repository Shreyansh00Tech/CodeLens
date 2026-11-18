/**
 * Bundle Monaco locally instead of loading it from a CDN at runtime, so the
 * code viewer works offline, behind firewalls and with strict CSPs.
 */
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import CssWorker from "monaco-editor/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "typescript" || label === "javascript") return new TsWorker();
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    return new EditorWorker();
  },
};

// Read-only viewer: skip type errors for files whose imports we don't load.
monaco.typescript?.typescriptDefaults?.setDiagnosticsOptions?.({ noSemanticValidation: true, noSyntaxValidation: false });
monaco.typescript?.javascriptDefaults?.setDiagnosticsOptions?.({ noSemanticValidation: true, noSyntaxValidation: false });

loader.config({ monaco });
