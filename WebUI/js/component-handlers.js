// ======================================================================
//  SS14 Prototype Editor – Component Handler Registry
// ======================================================================
//  Generic extension point for "special" component-type renderers. A
//  handler is a plain object with any subset of these hooks:
//
//    register('Sprite', {
//        decorateHeader(card, hdr, data, cMeta, ctx),
//        fieldOverrides: { [fieldTag]: (meta, value, onChange, ctx) => HTMLElement | null },
//        dataDefFieldOverrides: { [dataDefFullName]: { [fieldTag]: (meta, value, onChange, ctx) => HTMLElement | null } },
//    });
//
//  compCard() looks up its handler by compType and:
//    – pushes a render-stack frame around its own field loop so nested
//      dataDefCtrl() calls can find dataDefFieldOverrides at any depth;
//    – calls fieldOverrides[f.tag] inside the field loop and replaces the
//      .field-control-wrap contents with the returned element;
//    – calls decorateHeader after the body is built so handlers can
//      prepend a preview/widget above the field list.
//
//  Handlers are not loaded for inherited components — those are read-only.
// ======================================================================

'use strict';

const ComponentHandlerRegistry = (() => {
    const _handlers = {};
    const _stack = [];

    return {
        register(compType, handler) { _handlers[compType] = handler; },
        get(compType) { return _handlers[compType] || null; },

        // Walk up the active render stack to find a dataDef override.
        // The stack is needed because a single component (e.g. Sprite) can
        // contain nested DataDefinitions (PrototypeLayerData inside a list
        // inside Sprite). dataDefCtrl runs without knowing which component
        // it belongs to — it asks the registry, which checks the topmost
        // matching frame.
        pushContext(handler, ctx) { _stack.push({ handler, ctx }); },
        popContext() { _stack.pop(); },
        currentDataDefOverride(ddType, fieldTag) {
            for (let i = _stack.length - 1; i >= 0; i--) {
                const frame = _stack[i];
                const fn = frame.handler?.dataDefFieldOverrides?.[ddType]?.[fieldTag];
                if (fn) return { fn, ctx: frame.ctx };
            }
            return null;
        },
    };
})();
