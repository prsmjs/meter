import { runMeterSuite } from "./suite.js"
import { memoryDriver } from "../src/memoryDriver.js"

runMeterSuite("meter (memory)", async () => memoryDriver())
