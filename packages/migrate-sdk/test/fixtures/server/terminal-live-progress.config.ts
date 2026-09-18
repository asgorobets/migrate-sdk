import { makeLiveProgressConfig } from "./live-progress-fixture.ts";

// Leave time for intermediate snapshots with the one-second dashboard interval.
export default makeLiveProgressConfig(false, false, 1000);
