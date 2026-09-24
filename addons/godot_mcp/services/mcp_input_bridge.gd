extends Node
## Queues synthetic input events for the running game/editor.

const QUEUE_FILE := "mcp_input_queue.json"


func queue_events(events: Array) -> void:
	var path := OS.get_user_data_dir().path_join(QUEUE_FILE)
	var existing: Array = []
	if FileAccess.file_exists(path):
		var parsed = JSON.parse_string(FileAccess.get_file_as_string(path))
		if parsed is Array:
			existing = parsed
	existing.append_array(events)
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file:
		file.store_string(JSON.stringify(existing))
		file.close()


func _ready() -> void:
	# A game paused by its own UI (a results screen, a pause menu) would
	# otherwise silence this bridge completely: an autoload inherits the
	# pausable default, so `get_tree().paused = true` stops `_process` and
	# every MCP request times out. That is precisely the moment a caller
	# most wants to inspect the game. The bridge is a debug channel and
	# must outlive the pause it is trying to observe.
	process_mode = Node.PROCESS_MODE_ALWAYS


func _process(_delta: float) -> void:
	var path := OS.get_user_data_dir().path_join(QUEUE_FILE)
	if not FileAccess.file_exists(path):
		return
	var events = JSON.parse_string(FileAccess.get_file_as_string(path))
	DirAccess.remove_absolute(path)
	if not events is Array:
		return
	for ev in events:
		_apply(ev)


func _apply(ev: Dictionary) -> void:
	match ev.get("type", ""):
		"key":
			var e := InputEventKey.new()
			e.keycode = int(ev.get("keycode", 0))
			e.pressed = ev.get("pressed", true)
			Input.parse_input_event(e)
		"mouse_click":
			# A new event object for each edge. Input holds a parsed event by
			# reference until the frame's flush, so one object parsed twice,
			# with pressed flipped in between, turned the queued press into a
			# second release (measured 2026-09-24: a Liquid UI plate never
			# pressed while the same click still moved the hover onto it, and
			# the engine warned that an input event object was parsed more
			# than once in the same frame).
			for down in [true, false]:
				var e := InputEventMouseButton.new()
				e.position = Vector2(ev.get("x", 0), ev.get("y", 0))
				e.button_index = int(ev.get("button", MOUSE_BUTTON_LEFT))
				e.pressed = down
				Input.parse_input_event(e)
		"mouse_move":
			var e := InputEventMouseMotion.new()
			e.position = Vector2(ev.get("x", 0), ev.get("y", 0))
			Input.parse_input_event(e)
		"action":
			# A real event, not just Input's action state. Input.action_press()
			# dispatches nothing, so anything that reads input through _input or
			# _unhandled_input -- a menu, any UI -- never saw the press (measured
			# 2026-09-24: a Liquid UI menu ignored it). parse_input_event() sets
			# the same action state AND sends the event, so polled actions
			# (Input.is_action_pressed) keep working too.
			var e := InputEventAction.new()
			e.action = StringName(str(ev.get("action", "")))
			e.pressed = ev.get("pressed", true)
			Input.parse_input_event(e)
