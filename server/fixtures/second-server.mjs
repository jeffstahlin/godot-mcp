// A standalone MCP-server-like process that tries to bind an already-taken port.
import { GodotBridge } from "../build/godot-bridge.js";
const bridge = new GodotBridge();
bridge.start();
setTimeout(() => {
  console.log(`alive listening=${bridge.listening}`);
  bridge.close();
  process.exit(0);
}, 1000);
