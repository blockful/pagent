/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { Signal as PSignal } from '@preact/signals-core';
import { Signal as ASignal, WritableSignal as AWritableSignal } from '@angular/core';
declare module './signals' {
    interface SignalKinds<T> {
        angular: ASignal<T>;
        preact: PSignal<T>;
    }
    interface WritableSignalKinds<T> {
        angular: AWritableSignal<T>;
        preact: PSignal<T>;
    }
}
//# sourceMappingURL=signals.test.d.ts.map