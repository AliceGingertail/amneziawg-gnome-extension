// GObject signal emission is synchronous, while the click operation is async.
// Capture its Promise so recovery can await the very same handler as a real click.
export class ButtonActivation {
    constructor(button, onClick) {
        this._button = button;
        this._automatic = false;
        this._isCurrent = null;
        this._operation = null;
        this._signalId = button.connect('clicked', () => {
            this._operation = onClick({automatic: this._automatic,
                isCurrent: this._isCurrent ?? (() => true)});
        });
    }

    click(isCurrent = () => true) {
        if (!this._button)
            return Promise.resolve(false);
        this._automatic = true;
        this._isCurrent = isCurrent;
        this._operation = null;
        try {
            this._button.emit('clicked', 1);
            return this._operation ?? Promise.resolve(false);
        } finally {
            this._automatic = false;
            this._isCurrent = null;
        }
    }

    destroy() {
        this._button?.disconnect(this._signalId);
        this._button = null;
        this._operation = null;
    }
}
