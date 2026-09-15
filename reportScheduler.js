import cron from 'node-cron';
import { scheduleToCron, validateSchedule } from './reportStore.js';

export class ReportScheduler {
  constructor(store, run, { cronClient = cron, onError = console.error } = {}) {
    this.store = store;
    this.run = run;
    this.cron = cronClient;
    this.onError = onError;
    this.task = null;
  }

  createTask(schedule) {
    if (!schedule.enabled) return null;
    return this.cron.schedule(scheduleToCron(schedule), async () => {
      try { await this.run(); } catch (error) { this.onError(error); }
    }, { timezone: 'Asia/Seoul', scheduled: false });
  }

  start() {
    this.stop();
    this.task = this.createTask(this.store.getSchedule());
    this.task?.start();
  }

  update(schedule) {
    const next = validateSchedule(schedule);
    const nextTask = this.createTask(next);
    try {
      this.store.setSchedule(next);
    } catch (error) {
      nextTask?.stop();
      throw error;
    }
    this.stop();
    this.task = nextTask;
    this.task?.start();
    return next;
  }

  stop() {
    this.task?.stop();
    this.task = null;
  }
}
