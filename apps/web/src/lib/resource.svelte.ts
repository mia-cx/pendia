import { type FailureCode, readFailure } from "./errors.ts";

/** The load, failure and reload state every admin screen drives. */
export function resource<T>(load: () => Promise<T>) {
  let data = $state<T | undefined>(undefined);
  let failure = $state<{ code: FailureCode; message: string } | undefined>(
    undefined,
  );
  let loading = $state(true);
  let generation = 0;

  async function run() {
    const ticket = ++generation;
    loading = true;
    try {
      const result = await load();
      if (ticket === generation) {
        data = result;
        failure = undefined;
      }
    } catch (error) {
      if (ticket === generation) failure = readFailure(error);
    } finally {
      if (ticket === generation) loading = false;
    }
  }

  void run();

  return {
    get data() {
      return data;
    },
    get failure() {
      return failure;
    },
    get loading() {
      return loading;
    },
    reload: run,
  };
}
