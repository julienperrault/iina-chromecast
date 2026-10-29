import { state, tr } from "./state.js";
import { sendRpc } from "./daemon-client.js";
import { castToDevice } from "./sidebar-bridge.js";

const { menu, sidebar } = iina;

export function registerMenuEntries(): void {
  menu.addItem(
    menu.item(
      tr("menu.open_sidebar"),
      () => {
        sidebar.show();
      },
      { keyBinding: "Alt+c" }
    )
  );

  menu.addItem(
    menu.item(tr("menu.cast_selected"), () => {
      castToDevice();
    })
  );

  menu.addItem(
    menu.item(tr("menu.play_pause"), () => {
      if (state.castState === "PAUSED") {
        sendRpc("play");
      } else {
        sendRpc("pause");
      }
    })
  );

  menu.addItem(
    menu.item(tr("menu.stop_cast"), () => {
      sendRpc("stop");
    })
  );
}
