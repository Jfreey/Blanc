import React from "react";

// React 没有「渲染失败只坏一块」的机制：任何一个组件在 render 里抛异常，
// 整棵树都会被卸载 —— 用户看到的就是一片白屏（之前选图标白屏就是这个：
// 取图标名字时读了一个 null，异常一路冒到根）。
// 这个边界把异常关在一小块里，其它部分照常能用。
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }
  static getDerivedStateFromError(err) {
    return { err };
  }
  componentDidCatch(err, info) {
    // 控制台留一份，开发时能直接看到堆栈
    console.error("[ErrorBoundary]", err, info && info.componentStack);
  }
  render() {
    if (!this.state.err) return this.props.children;
    // fallback 也要能撑住：外面一层包一层，最外层那块画提示
    if (this.props.fallback) return this.props.fallback;
    return (
      <div className="eb-crash">
        <div className="eb-msg">这块出了点问题，已经隔离开了</div>
        <code className="eb-detail">{String(this.state.err && this.state.err.message || this.state.err)}</code>
        <button className="eb-again" onClick={() => this.setState({ err: null })}>重试</button>
      </div>
    );
  }
}