// Model the two native events that bind an admitted input to its reply permit.
export function turnEvents() {
  const listeners = [];
  let turn = 0;
  return {
    on(name, listener) {
      if (name === 'session/event') listeners.push(listener);
    },
    followup(session, message) {
      turn += 1;
      for (const event of [
        {type: 'turn/start', data: {turn}},
        {type: 'user/message', data: {id: message.id}},
      ]) for (const listener of listeners) listener(session, event);
    },
  };
}
