/*
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
import { html, nothing, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { ChoicePickerApi } from '@a2ui/web_core/v0_9/basic_catalog';
import { BasicCatalogA2uiLitElement } from '../basic-catalog-a2ui-lit-element.js';
import { A2uiController } from '@a2ui/lit/v0_9';
let A2uiChoicePickerElement = (() => {
    let _classDecorators = [customElement('a2ui-choicepicker')];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = BasicCatalogA2uiLitElement;
    let _filter_decorators;
    let _filter_initializers = [];
    let _filter_extraInitializers = [];
    var A2uiChoicePickerElement = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _filter_decorators = [state()];
            __esDecorate(this, null, _filter_decorators, { kind: "accessor", name: "filter", static: false, private: false, access: { has: obj => "filter" in obj, get: obj => obj.filter, set: (obj, value) => { obj.filter = value; } }, metadata: _metadata }, _filter_initializers, _filter_extraInitializers);
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            A2uiChoicePickerElement = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        /**
         * The styles of the choice picker can be customized by redefining the following
         * CSS variables:
         *
         * - `--a2ui-choicepicker-label-color`: Color of all labels.
         * - `--a2ui-choicepicker-label-font-size`: Font size of all labels. Defaults to `--a2ui-label-font-size` then `--a2ui-font-size-s` for the main label.
         * - `--a2ui-choicepicker-label-font-weight`: Font weight of the main label. Defaults to `--a2ui-label-font-weight` then `bold`.
         * - `--a2ui-choicepicker-gap`: Spacing between options.
         * - `--a2ui-choicepicker-filter-padding`: Padding for the filter input. Defaults to `--a2ui-spacing-xs` and `--a2ui-spacing-s` (4px 8px).
         * - `--a2ui-choicepicker-chip-padding`: Padding for chips. Defaults to `--a2ui-spacing-s` and `--a2ui-spacing-m` (4px 8px).
         * - `--a2ui-choicepicker-chip-border-radius`: Border radius for chips. Defaults to `999px`.
         */
        static { this.styles = css `
    :host {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 0;
    }
    .options {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    label {
      color: var(--a2ui-color-on-surface, #0a0a0a);
      font-size: 0.875rem;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      cursor: pointer;
    }
    label input[type="radio"],
    label input[type="checkbox"] {
      accent-color: var(--a2ui-color-primary, #5154b3);
      cursor: pointer;
    }
    :host > label {
      font-size: 0.875rem;
      font-weight: 500;
      cursor: default;
    }
    .filter-input {
      background-color: transparent;
      color: var(--a2ui-color-on-input, #0a0a0a);
      border: 1px solid var(--a2ui-color-border, #e4e4e7);
      border-radius: var(--a2ui-border-radius, 0.375rem);
      padding: 0.5rem 0.75rem;
      font-family: inherit;
      font-size: 0.875rem;
      transition: border-color 150ms cubic-bezier(0.4, 0, 0.2, 1);
    }
    .filter-input::placeholder {
      color: var(--a2ui-color-muted-fg, #71717a);
    }
    .filter-input:focus {
      outline: 2px solid var(--a2ui-color-ring, var(--a2ui-color-primary, #5154b3));
      outline-offset: 2px;
      border-color: var(--a2ui-color-border, #e4e4e7);
    }
    .chips {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 0.375rem;
    }
    .chip {
      padding: 0.375rem 0.875rem;
      border-radius: 9999px;
      border: 1px solid var(--a2ui-color-border, #e4e4e7);
      background-color: transparent;
      color: var(--a2ui-color-on-surface, #0a0a0a);
      cursor: pointer;
      font-size: 0.8125rem;
      font-weight: 500;
      font-family: inherit;
      line-height: 1.25rem;
      transition: background-color 150ms cubic-bezier(0.4, 0, 0.2, 1), border-color 150ms cubic-bezier(0.4, 0, 0.2, 1), color 150ms cubic-bezier(0.4, 0, 0.2, 1);
    }
    .chip:hover {
      background-color: var(--a2ui-color-secondary, #f4f4f5);
    }
    .chip:focus-visible {
      outline: 2px solid var(--a2ui-color-ring, var(--a2ui-color-primary, #5154b3));
      outline-offset: 2px;
    }
    .chip.selected {
      background-color: var(--a2ui-color-primary, #5154b3);
      color: var(--a2ui-color-on-primary, #fff);
      border-color: var(--a2ui-color-primary, #5154b3);
    }
    .chip.selected:hover {
      background-color: var(--a2ui-color-primary-hover, #4345a0);
    }
  `; }
        #filter_accessor_storage = __runInitializers(this, _filter_initializers, '');
        get filter() { return this.#filter_accessor_storage; }
        set filter(value) { this.#filter_accessor_storage = value; }
        createController() {
            return new A2uiController(this, ChoicePickerApi);
        }
        render() {
            const props = this.controller.props;
            if (!props)
                return nothing;
            const selected = Array.isArray(props.value) ? props.value : [];
            const isMulti = props.variant === 'multipleSelection';
            const isChips = props.displayStyle === 'chips';
            const toggle = (val) => {
                if (!props.setValue)
                    return;
                if (isMulti) {
                    if (selected.includes(val)) {
                        props.setValue(selected.filter((v) => v !== val));
                    }
                    else {
                        props.setValue([...selected, val]);
                    }
                }
                else {
                    props.setValue([val]);
                }
            };
            const options = (props.options || []).filter((opt) => !props.filterable ||
                this.filter === '' ||
                String(opt.label).toLowerCase().includes(this.filter.toLowerCase()));
            return html `
      ${props.label ? html `<label>${props.label}</label>` : nothing}
      ${props.filterable
                ? html `
            <input
              type="text"
              class="filter-input"
              placeholder="Filter options..."
              aria-label="Filter options"
              .value=${this.filter}
              @input=${(e) => (this.filter = e.target.value)}
            />
          `
                : nothing}
      <div class=${classMap({ options: true, chips: isChips })}>
        ${options.map((opt) => isChips
                ? html `
                <button
                  class=${classMap({
                    chip: true,
                    selected: selected.includes(opt.value),
                })}
                  aria-pressed=${selected.includes(opt.value)}
                  @click=${() => toggle(opt.value)}
                >
                  ${opt.label}
                </button>
              `
                : html `
                <label>
                  <input
                    type=${isMulti ? 'checkbox' : 'radio'}
                    .checked=${selected.includes(opt.value)}
                    @change=${() => toggle(opt.value)}
                  />
                  ${opt.label}
                </label>
              `)}
      </div>
    `;
        }
        constructor() {
            super(...arguments);
            __runInitializers(this, _filter_extraInitializers);
        }
        static {
            __runInitializers(_classThis, _classExtraInitializers);
        }
    };
    return A2uiChoicePickerElement = _classThis;
})();
export { A2uiChoicePickerElement };
export const A2uiChoicePicker = {
    ...ChoicePickerApi,
    tagName: 'a2ui-choicepicker',
};
//# sourceMappingURL=ChoicePicker.js.map