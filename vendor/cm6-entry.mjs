/* CodeMirror 6 bundle entry for luci-app-settings.
 * Exposes everything the LuCI view needs on window.__CM6. */

import { EditorState } from '@codemirror/state';
import {
	EditorView, keymap, lineNumbers, drawSelection, highlightSpecialChars,
	highlightActiveLine, highlightActiveLineGutter
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
	StreamLanguage, bracketMatching, syntaxHighlighting, defaultHighlightStyle,
	indentOnInput
} from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { linter, lintGutter, lintKeymap, setDiagnostics } from '@codemirror/lint';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { oneDark } from '@codemirror/theme-one-dark';

window.__CM6 = {
	EditorState,
	EditorView, keymap, lineNumbers, drawSelection, highlightSpecialChars,
	highlightActiveLine, highlightActiveLineGutter,
	defaultKeymap, history, historyKeymap, indentWithTab,
	StreamLanguage, bracketMatching, syntaxHighlighting, defaultHighlightStyle,
	indentOnInput,
	searchKeymap, highlightSelectionMatches,
	linter, lintGutter, lintKeymap, setDiagnostics,
	json, jsonParseLinter,
	shell,
	oneDark
};
