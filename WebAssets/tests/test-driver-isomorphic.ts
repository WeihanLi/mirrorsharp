import type { EditorView } from '@codemirror/next/view';
import { TransactionSpec, Transaction } from '@codemirror/next/state';
import type { PartData, CompletionItemData, ChangeData, ChangesMessage } from '../ts/interfaces/protocol';
import mirrorsharp, { MirrorSharpOptions, MirrorSharpInstance } from '../ts/mirrorsharp';

type TestRecorderOptions = { exclude?: (object: object, action: string) => boolean };

class TestRecorder {
    readonly #objects = new Map<string, Record<string, unknown>>();
    readonly #actions = new Array<{ target: string; action: string; args: ReadonlyArray<unknown> }>();

    constructor(targets: ReadonlyArray<object>, options: TestRecorderOptions = {}) {
        for (const target of targets) {
            this.#observe(target as Record<string, unknown>, options);
        }
    }

    #getAllPropertyNames = (object: Record<string, unknown>) => {
        const names = new Array<string>();
        let current = object as object|undefined;
        while (current) {
            names.push(...Object.getOwnPropertyNames(current));
            current = Object.getPrototypeOf(current);
        }
        return [...new Set<string>(names)];
    };

    #observe = (object: Record<string, unknown>, { exclude = () => false }: Pick<TestRecorderOptions, 'exclude'>) => {
        const target = object.constructor.name;
        this.#objects.set(target, object);
        const actions = this.#actions;
        for (const key of this.#getAllPropertyNames(object)) {
            const value = object[key];
            if (typeof value !== 'function' || key === 'constructor')
                continue;
            if (exclude(object, key))
                continue;
            object[key] = function(...args: ReadonlyArray<unknown>) {
                actions.push({ target, action: key, args });
                return value.apply(this, args) as unknown;
            };
        }
    };

    async replayFromJSON({ actions }: ReturnType<TestRecorder['toJSON']>) {
        for (const { target, action, args } of actions) {
            console.log('Replay:', target, action, args);
            const object = this.#objects.get(target)!;
            const result = (object[action] as (...args: ReadonlyArray<unknown>) => unknown)(...args);
            if ((result as { then?: unknown })?.then)
                await result;
        }
    }

    toJSON() {
        for (const { target, action, args } of this.#actions) {
            for (const arg of args) {
                if (typeof arg === 'function')
                    throw new Error(`Cannot serialize function argument ${arg.name} of action ${target}.${action}.`);
            }
        }
        return {
            actions: this.#actions
        };
    }
}

interface MockSocketMessageEvent {
    readonly data: string;
}

class MockSocket {
    public createdCount = 0;
    public sent: Array<string>;

    readonly #handlers = {} as {
        open?: Array<() => void>;
        message?: Array<(e: MockSocketMessageEvent) => void>;
        close?: Array<() => void>;
    };

    constructor() {
        this.sent = [];
    }

    send(message: string) {
        this.sent.push(message);
    }

    trigger(event: 'open'): void;
    trigger(event: 'message', e: MockSocketMessageEvent): void;
    trigger(event: 'close'): void;
    trigger(...[event, e]: ['open']|['message', MockSocketMessageEvent]|['close']) {
        // https://github.com/microsoft/TypeScript/issues/37505 ?
        for (const handler of (this.#handlers[event] ?? [])) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call
            (handler as (...args: any) => void)(e);
        }
    }

    addEventListener(event: 'open', handler: () => void): void;
    addEventListener(event: 'message', handler: (e: MockSocketMessageEvent) => void): void;
    addEventListener(event: 'close', handler: () => void): void;
    addEventListener(...[event, handler]: ['open', () => void]|['message', (e: MockSocketMessageEvent) => void]|['close', () => void]) {
        let handlers = this.#handlers[event];
        if (!handlers) {
            handlers = [] as NonNullable<typeof handlers>;
            this.#handlers[event] = handlers;
        }
        handlers.push(handler);
    }
}

/*
class TestKeys {
    readonly #cmView: EditorView;

    constructor(cmView: EditorView) {
        this.#cmView = cmView;
    }

    backspace(count: number) {
        const { node, offset } = this.getCursorInfo();
        for (let i = 0; i < count; i++) {
            node.textContent = spliceString(node.textContent!, offset, 1);
            keyboard.dispatchEventsForAction('backspace', this.#cmView.contentDOM);
        }
    }

    press(keys: string) {
        keyboard.dispatchEventsForAction(keys, this.#cmView.contentDOM);
    }

    private getCursorInfo() {
        const index = this.#cmView.state.selection.primary.from;
        return this.#cmView.domAtPos(index);
    }
}
*/

class TestText {
    readonly #cmView: EditorView;

    constructor(cmView: EditorView) {
        this.#cmView = cmView;
    }

    type(text: string) {
        let cursorOffset = this.#cmView.state.selection.primary.anchor;
        for (const char of text) {
            const newCursorOffset = cursorOffset + 1;
            this.#cmView.dispatch(this.#cmView.state.update({
                annotations: [Transaction.userEvent.of('input')],
                changes: { from: cursorOffset, insert: char },
                selection: { anchor: newCursorOffset }
            }));
            cursorOffset = newCursorOffset;
        }
    }
}

class TestReceiver {
    private readonly socket: MockSocket;

    constructor(socket: MockSocket) {
        this.socket = socket;
    }

    changes(reason: ChangesMessage['reason'], changes: ReadonlyArray<ChangeData> = []) {
        this.socket.trigger('message', { data: JSON.stringify({ type: 'changes', changes, reason }) });
    }

    optionsEcho(options = {}) {
        this.socket.trigger('message', { data: JSON.stringify({ type: 'optionsEcho', options }) });
    }

    completions(completions: ReadonlyArray<CompletionItemData> = [], { span = {}, commitChars = null, suggestion = null } = {}) {
        this.socket.trigger('message', { data: JSON.stringify({ type: 'completions', completions, span, commitChars, suggestion }) });
    }

    completionInfo(index: number, parts: ReadonlyArray<PartData>) {
        this.socket.trigger('message', { data: JSON.stringify({ type: 'completionInfo', index, parts }) });
    }
}

type TestDriverOptions<TExtensionServerOptions, TSlowUpdateExtensionData> = ({}|{ text: string; cursor?: number }|{ textWithCursor: string }) & {
    keepSocketClosed?: boolean;
    options?: Partial<MirrorSharpOptions<TExtensionServerOptions, TSlowUpdateExtensionData>> & {
        initialText?: never;
        initialCursorOffset?: never;
        configureCodeMirror?: never;
    };
};

const timers = {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    runOnlyPendingTimers() {
        console.log('runOnlyPendingTimers');
    },

    advanceTimersByTime(ms: number) {
        console.log('advanceTimersByTime', ms);
    },

    advanceTimersToNextTimer() {
        console.log('advanceTimersToNextTimer');
    }
};

function setTimers(implementation: typeof timers) {
    Object.assign(timers, implementation);
}

class TestDriver<TExtensionServerOptions = never> {
    public readonly socket: MockSocket;
    public readonly mirrorsharp: MirrorSharpInstance<TExtensionServerOptions>;
    //public readonly keys: TestKeys;
    public readonly text: TestText;
    public readonly receive: TestReceiver;
    public readonly recorder: TestRecorder;

    readonly #cmView: EditorView;
    readonly #optionsForJSONOnly: TestDriverOptions<TExtensionServerOptions, unknown>;

    protected constructor(
        socket: MockSocket,
        mirrorsharp: MirrorSharpInstance<TExtensionServerOptions>,
        optionsForJSONOnly: TestDriverOptions<TExtensionServerOptions, unknown>
    ) {
        const cmView = mirrorsharp.getCodeMirrorView();

        this.socket = socket;
        this.#cmView = cmView;
        this.mirrorsharp = mirrorsharp;
        //this.keys = new TestKeys(cmView);
        this.text = new TestText(cmView);
        this.receive = new TestReceiver(socket);
        this.recorder = new TestRecorder([
            /*this.keys, */this.text, this.receive, this
        ], {
            exclude: (object, key) => object === this && (key === 'render' || key === 'toJSON')
        });

        this.#optionsForJSONOnly = optionsForJSONOnly;
    }

    getCodeMirrorView() {
        return this.#cmView;
    }

    dispatchCodeMirrorTransaction(...specs: ReadonlyArray<TransactionSpec>) {
        this.#cmView.dispatch(this.#cmView.state.update(...specs));
    }

    async completeBackgroundWork() {
        timers.runOnlyPendingTimers();
        await new Promise(resolve => resolve());
        timers.runOnlyPendingTimers();
    }

    async completeBackgroundWorkAfterEach(...actions: ReadonlyArray<() => void>) {
        for (const action of actions) {
            action();
            await this.completeBackgroundWork();
        }
    }

    async advanceTimeAndCompleteNextLinting() {
        timers.advanceTimersByTime(1000);
        timers.advanceTimersToNextTimer();
        await this.completeBackgroundWork();
    }

    toJSON() {
        return {
            options: this.#optionsForJSONOnly,
            recorder: this.recorder.toJSON()
        };
    }

    static async new<TExtensionServerOptions = never, TSlowUpdateExtensionData = never>(
        options: TestDriverOptions<TExtensionServerOptions, TSlowUpdateExtensionData>
    ) {
        const initial = getInitialState(options);

        const container = document.createElement('div');
        document.body.appendChild(container);

        if (globalThis.WebSocket instanceof MockSocket)
            throw new Error(`Global WebSocket is already set up in this context.`);

        const socket = new MockSocket();
        (globalThis as unknown as { WebSocket: () => Partial<WebSocket> }).WebSocket = function() {
            socket.createdCount += 1;
            return socket;
        };

        const msOptions = {
            ...(options.options ?? {}),
            initialText: initial.text ?? '',
            initialCursorOffset: initial.cursor
        } as MirrorSharpOptions<TExtensionServerOptions, TSlowUpdateExtensionData>;
        const ms = mirrorsharp(container, msOptions);

        const driver = new this(socket, ms, options as TestDriverOptions<TExtensionServerOptions, unknown>);

        if (options.keepSocketClosed)
            return driver;

        driver.socket.trigger('open');
        await driver.completeBackgroundWork();

        timers.runOnlyPendingTimers();
        driver.socket.sent = [];
        return driver;
    }

    static async fromJSON({ options, recorder }: ReturnType<TestDriver<unknown>['toJSON']>) {
        const driver = await this.new(options);
        await driver.recorder.replayFromJSON(recorder);
        return driver;
    }
}

function getInitialState(options: {}|{ text: string; cursor?: number }|{ textWithCursor: string }) {
    let { text, cursor } = options as { text?: string; cursor?: number };
    if ('textWithCursor' in options) {
        text = options.textWithCursor.replace('|', '');
        cursor = options.textWithCursor.indexOf('|');
    }
    return { text, cursor };
}

type TestDriverConstructorArguments<TExtensionServerOptions> = [
    MockSocket,
    MirrorSharpInstance<TExtensionServerOptions>,
    TestDriverOptions<TExtensionServerOptions, unknown>
];

export { TestDriver, TestDriverOptions, TestDriverConstructorArguments, setTimers };