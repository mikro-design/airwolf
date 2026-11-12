import { Component, type ReactNode } from 'react';

export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; status: string }
> {
  state = { failed: false, status: 'Stopping the receiver…' };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    void window.dissector?.stop();
    Promise.resolve(window.radio?.stop()).then(
      () => this.setState({ status: 'The receiver is stopped.' }),
      () =>
        this.setState({
          status: 'Could not confirm receiver shutdown. Close Airwolf to release it.',
        }),
    );
  }
  render() {
    return this.state.failed ? (
      <main className="error-screen" role="alert">
        <h1>Airwolf could not display this session</h1>
        <p>{this.state.status} Reload to start a new session.</p>
        <button className="button primary" onClick={() => location.reload()}>
          Reload Airwolf
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
