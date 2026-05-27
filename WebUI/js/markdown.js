// Minimal Markdown renderer used by the in-app Changelog tab.
//
// Intentionally small: we do not want a transitive dep on a full markdown
// library for what is effectively one document. Supports the subset that a
// changelog needs:
//   - ATX headings (# … ######)
//   - Paragraphs
//   - Unordered (-, *, +) and ordered (1.) lists with simple nesting
//   - Fenced code blocks (``` … ```), optional language
//   - Inline code (`x`)
//   - Bold (**x**) and italic (*x* / _x_)
//   - Links [text](url) — http(s) only, opened in the OS browser via shell
//   - Blockquotes (> …)
//   - Horizontal rules (--- / ***)
//
// HTML in the source is escaped: this file may be edited by humans and must
// not be turned into an XSS vector inside the editor's webview.

'use strict';

(function () {
    function esc(s) {
        return s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function inline(s) {
        // Inline code first — its contents must not be touched by other rules.
        const codes = [];
        s = s.replace(/`([^`\n]+)`/g, (_, c) => {
            codes.push(c);
            return `\u0000${codes.length - 1}\u0000`;
        });
        s = esc(s);
        // Links [text](url). url may not contain whitespace or closing paren.
        s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
            const safe = /^https?:\/\//i.test(u) ? u : '#';
            return `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${t}</a>`;
        });
        // Bold then italic. Both need non-greedy matches.
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
        s = s.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
        // Restore inline code placeholders.
        s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
        return s;
    }

    function render(md) {
        const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
        const out = [];
        let i = 0;

        // listStack tracks currently-open list elements so we can close them
        // when the indent decreases or a non-list line appears.
        const listStack = []; // [{ tag: 'ul'|'ol', indent: number }]
        const closeListsTo = depth => {
            while (listStack.length > depth) {
                out.push(`</li></${listStack.pop().tag}>`);
            }
        };
        const closeAllLists = () => closeListsTo(0);

        while (i < lines.length) {
            const raw = lines[i];

            // Fenced code block
            const fence = raw.match(/^```\s*([\w-]*)\s*$/);
            if (fence) {
                closeAllLists();
                const lang = fence[1] || '';
                const body = [];
                i++;
                while (i < lines.length && !/^```\s*$/.test(lines[i])) {
                    body.push(lines[i]);
                    i++;
                }
                i++; // skip closing fence (or EOF)
                const cls = lang ? ` class="lang-${esc(lang)}"` : '';
                out.push(`<pre><code${cls}>${esc(body.join('\n'))}</code></pre>`);
                continue;
            }

            // Blank line — ends paragraph / lists context (only lists close
            // on real outdent, blanks alone don't close them — they let the
            // next line start a new top-level block).
            if (/^\s*$/.test(raw)) {
                closeAllLists();
                i++;
                continue;
            }

            // Horizontal rule
            if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) {
                closeAllLists();
                out.push('<hr>');
                i++;
                continue;
            }

            // Heading
            const h = raw.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
            if (h) {
                closeAllLists();
                const lvl = h[1].length;
                out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
                i++;
                continue;
            }

            // Blockquote (consecutive > lines collapse into one block)
            if (/^\s*>\s?/.test(raw)) {
                closeAllLists();
                const buf = [];
                while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
                    buf.push(lines[i].replace(/^\s*>\s?/, ''));
                    i++;
                }
                out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
                continue;
            }

            // List item
            const li = raw.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
            if (li) {
                const indent = li[1].replace(/\t/g, '    ').length;
                const tag = /^\d/.test(li[2]) ? 'ol' : 'ul';
                // Pop deeper lists.
                while (listStack.length && listStack[listStack.length - 1].indent > indent) {
                    out.push(`</li></${listStack.pop().tag}>`);
                }
                const top = listStack[listStack.length - 1];
                if (!top || top.indent < indent) {
                    out.push(`<${tag}><li>`);
                    listStack.push({ tag, indent });
                } else {
                    // Same level — close the previous <li>, switch tag if needed.
                    if (top.tag !== tag) {
                        out.push(`</li></${top.tag}><${tag}><li>`);
                        listStack[listStack.length - 1] = { tag, indent };
                    } else {
                        out.push('</li><li>');
                    }
                }
                out.push(inline(li[3]));
                i++;
                continue;
            }

            // Plain paragraph — accumulate consecutive non-empty, non-special lines.
            closeAllLists();
            const para = [raw];
            i++;
            while (
                i < lines.length &&
                lines[i].trim() !== '' &&
                !/^```/.test(lines[i]) &&
                !/^#{1,6}\s/.test(lines[i]) &&
                !/^\s*>/.test(lines[i]) &&
                !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) &&
                !/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
            ) {
                para.push(lines[i]);
                i++;
            }
            out.push(`<p>${inline(para.join(' '))}</p>`);
        }
        closeAllLists();
        return out.join('\n');
    }

    window.renderMarkdown = render;
})();
