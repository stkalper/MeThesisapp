import { useEffect, useState } from "react";
import { api, type Me } from "./api";
import { BottomNav, ToastHost, useRoute } from "./components";
import { Coach } from "./screens/Coach";
import { Home } from "./screens/Home";
import { Memory } from "./screens/Memory";
import { NewPosition } from "./screens/NewPosition";
import { PositionDetail } from "./screens/PositionDetail";
import { Positions } from "./screens/Positions";
import { Proof } from "./screens/Proof";
import { Verify } from "./screens/Verify";
import { tg } from "./telegram";

export function App() {
  const route = useRoute();
  const [me, setMe] = useState<Me>();
  const [authError, setAuthError] = useState<string>();

  useEffect(() => {
    api.me().then(setMe).catch((err) => setAuthError((err as Error).message));
  }, []);

  // Telegram's native back button on nested screens.
  useEffect(() => {
    const back = tg?.BackButton;
    if (!back) return;
    const onBack = () => history.back();
    if (route === "/") back.hide();
    else back.show();
    back.onClick(onBack);
    return () => back.offClick(onBack);
  }, [route]);

  // Public verify page: opened by anyone from a shared link, no Telegram login needed.
  const verify = route.match(/^\/verify\/([\w-]+)/);
  if (verify) {
    return (
      <div className="app" style={{ paddingBottom: 32 }}>
        <ToastHost />
        <Verify id={verify[1]!} />
      </div>
    );
  }

  if (authError) {
    return (
      <div className="app">
        <div className="card" style={{ marginTop: 40 }}>
          <div className="card-title">Thesis Keeper</div>
          <p className="eyebrow">{authError}</p>
          <p className="small" style={{ color: "var(--on-navy-soft)" }}>Open this Mini App from the bot's menu button in Telegram.</p>
        </div>
      </div>
    );
  }

  let screen;
  const detail = route.match(/^\/position\/([\w-]+)/);
  if (detail) screen = <PositionDetail id={detail[1]!} />;
  else if (route === "/positions") screen = <Positions />;
  else if (route === "/new") screen = <NewPosition />;
  else if (route === "/coach") screen = <Coach />;
  else if (route === "/memory") screen = <Memory me={me} />;
  else if (route === "/proof") screen = <Proof />;
  else screen = <Home me={me} />;

  return (
    <div className="app">
      <ToastHost />
      <div key={route}>{screen}</div>
      <BottomNav route={route} />
    </div>
  );
}
