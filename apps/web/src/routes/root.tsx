import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { useMe } from "../lib/hooks";

function RootLayout() {
  const me = useMe();
  return (
    <>
      <header className="app-header">
        <Link to="/" className="brand">
          <span className="prompt">❯</span> runnerbox
        </Link>
        <div className="user">
          {me.data ? (
            <>
              <img src={me.data.avatarUrl} alt="" referrerPolicy="no-referrer" />
              <span>{me.data.login}</span>
            </>
          ) : null}
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </>
  );
}

export const rootRoute = createRootRoute({ component: RootLayout });
