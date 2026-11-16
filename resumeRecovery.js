// Experimental recovery policy. Firewall protection must exist independently.
export class ResumeRecovery {
    constructor({getState, reconnect, schedule, cancelSchedule, onError, translate = message => message}) {
        this._getState = getState;
        this._reconnect = reconnect;
        this._schedule = schedule;
        this._cancelSchedule = cancelSchedule;
        this._onError = onError;
        this._translate = translate;
        this._sleeping = false;
        this._target = null;
        this._timer = null;
        this._generation = 0;
        this._running = false;
        this._destroyed = false;
    }

    prepareForSleep(sleeping) {
        if (this._destroyed || sleeping === this._sleeping)
            return;
        this._sleeping = sleeping;
        if (sleeping) {
            this.cancel();
            const state = this._getState();
            if (!this._running && state.enabled && state.connected && !state.busy) {
                this._target = state.serverId;
                if (!this._target)
                    this._onError(this._translate('Experimental reconnect skipped: the active server is unknown'));
            }
        } else {
            this.changed();
        }
    }

    changed() {
        if (this._destroyed)
            return;
        const state = this._getState();
        if (!state.enabled) {
            this.cancel();
            return;
        }
        // Do not replace another connection made by the GUI while waking up.
        if (this._target && state.connected && state.serverId && state.serverId !== this._target) {
            this.cancel();
            return;
        }
        const ready = !this._sleeping && state.available && !state.busy;
        if (!ready || !this._target || this._running) {
            this._clearTimer();
            return;
        }
        if (this._timer !== null)
            return;
        const generation = this._generation;
        // Give the service a short settling period after resume.
        this._timer = this._schedule(() => {
            this._timer = null;
            const current = this._getState();
            if (generation !== this._generation || !current.enabled || this._sleeping ||
                !current.available || current.busy)
                return;
            const target = this._target;
            this._target = null;
            this._running = true;
            const isCurrent = () => !this._destroyed && generation === this._generation &&
                !this._sleeping && this._getState().enabled;
            Promise.resolve().then(() => {
                if (isCurrent())
                    return this._reconnect(target, isCurrent);
            }).catch(error => {
                if (isCurrent())
                    this._onError(error.message);
            }).finally(() => { this._running = false; });
        }, 2000);
    }

    _clearTimer() {
        if (this._timer !== null)
            this._cancelSchedule(this._timer);
        this._timer = null;
    }

    cancel() {
        ++this._generation;
        this._target = null;
        this._clearTimer();
    }

    reset() {
        this.cancel();
        this._sleeping = false;
    }

    destroy() {
        this._destroyed = true;
        this.cancel();
    }
}
