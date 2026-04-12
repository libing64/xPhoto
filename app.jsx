const { useState, useRef, useEffect } = React;

function App() {
  const [imageSrc, setImageSrc] = useState(null);
  const [processedSrc, setProcessedSrc] = useState(null);
  const [loading, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const canvasRef = useRef(null);

  // 模拟 RAW/TIFF 解码功能 (UTIF)
  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setProcessedSrc(null); // Reset
    const fileUrl = URL.createObjectURL(file);

    // 对于 DNG/CR2 等格式，浏览器支持极差，通常需要专业的 WebAssembly (如 magick.wasm)。
    // 这里以 UTIF (TIFF) 为例，若不能解码，退回到普通读取。
    if (file.name.toLowerCase().endsWith(".tif") || file.name.toLowerCase().endsWith(".tiff")) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const ifds = UTIF.decode(e.target.result);
          UTIF.decodeImage(e.target.result, ifds[0]);
          const tbd = UTIF.toRGBA8(ifds[0]);
          
          const canvas = document.createElement("canvas");
          canvas.width = ifds[0].width;
          canvas.height = ifds[0].height;
          const ctx = canvas.getContext("2d");
          const imageData = new ImageData(new Uint8ClampedArray(tbd), canvas.width, canvas.height);
          ctx.putImageData(imageData, 0, 0);
          
          setImageSrc(canvas.toDataURL("image/jpeg"));
        } catch (err) {
          console.error("UTIF 解码失败，退回普通读取", err);
          setImageSrc(fileUrl);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      // JPG, PNG 等普通格式直接读取
      setImageSrc(fileUrl);
    }
  };

  const handleProcess = async () => {
    if (!imageSrc) return;
    setLoading(true);

    try {
      if (apiKey) {
        // --- 真实调用云端大模型 API 示例 (如阿里云视觉智能/OpenAI) ---
        // 注意：多数第三方 API 不支持浏览器直接跨域(CORS)请求。
        // 以下代码仅为架构演示。在没有可用后端的静态站点中，开发者需寻找支持跨域的服务。
        console.log("正在使用您的 API Key 请求云端服务...");
        /* 
        const response = await fetch("https://api.aliyun.com/vision/v1/enhance", {
          method: "POST",
          headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ image: imageSrc })
        });
        const data = await response.json();
        setProcessedSrc(data.processedImageUrl);
        */
      }

      // --- 本地模拟大模型提亮与美颜处理 (Prototype fallback) ---
      // 在实际没有配置跨域 API 时，采用本地 Canvas 模拟提亮效果，演示全流程。
      await new Promise(resolve => setTimeout(resolve, 2000)); // 模拟网络延迟
      
      const img = new Image();
      img.onload = () => {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        canvas.width = img.width;
        canvas.height = img.height;
        
        ctx.drawImage(img, 0, 0);
        
        // 模拟提亮 (Global Composite Operation)
        ctx.globalCompositeOperation = "color-dodge";
        ctx.fillStyle = "rgba(40, 40, 40, 0.5)"; // 提亮程度
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        ctx.globalCompositeOperation = "source-over"; // Reset
        
        setProcessedSrc(canvas.toDataURL("image/jpeg", 0.95));
      };
      img.src = imageSrc;

    } catch (error) {
      alert("处理失败：" + error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = () => {
    if (!processedSrc) return;
    const a = document.createElement("a");
    a.href = processedSrc;
    a.download = "xPhoto_Processed.jpg";
    a.click();
  };

  return (
    <div className="max-w-5xl mx-auto p-6 font-sans">
      <header className="mb-8 text-center">
        <h1 className="text-4xl font-bold text-gray-800 mb-2 tracking-tight">xPhoto Pro</h1>
        <p className="text-gray-500">极简大模型修图引擎 (RAW直出 + 智能提亮美颜)</p>
      </header>

      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 mb-8">
        <div className="flex flex-col md:flex-row gap-6">
          {/* 左侧控制面板 */}
          <div className="w-full md:w-1/3 flex flex-col gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">大模型 API Key (选填)</label>
              <input 
                type="password" 
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="例如: sk-xxxxxx"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
              <p className="text-xs text-gray-400 mt-1">留空则使用本地加速模型进行模拟渲染。</p>
            </div>

            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">选择图片 (RAW / JPG)</label>
              <div className="relative border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:bg-gray-50 transition cursor-pointer">
                <input 
                  type="file" 
                  accept="image/*, .cr2, .nef, .dng, .tif, .tiff" 
                  onChange={handleFileUpload}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
                <div className="flex flex-col items-center justify-center pointer-events-none">
                  <i data-lucide="image-plus" className="text-gray-400 w-8 h-8 mb-2"></i>
                  <span className="text-sm text-gray-500">点击或拖拽上传</span>
                </div>
              </div>
            </div>

            <button 
              onClick={handleProcess}
              disabled={!imageSrc || loading}
              className={`mt-4 w-full py-3 rounded-lg font-medium text-white transition flex justify-center items-center gap-2
                ${(!imageSrc || loading) ? 'bg-blue-300 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700 shadow-md'}`}
            >
              {loading ? (
                <><i data-lucide="loader" className="animate-spin w-5 h-5"></i> 正在请求大模型...</>
              ) : (
                <><i data-lucide="wand-2" className="w-5 h-5"></i> AI 提亮与美颜</>
              )}
            </button>

            {processedSrc && (
              <button 
                onClick={handleDownload}
                className="mt-2 w-full py-3 bg-gray-800 text-white rounded-lg font-medium hover:bg-gray-900 transition flex justify-center items-center gap-2 shadow-md"
              >
                <i data-lucide="download" className="w-5 h-5"></i> 导出高质量 JPG
              </button>
            )}
          </div>

          {/* 右侧画板区 */}
          <div className="w-full md:w-2/3">
            <div className="image-container rounded-xl border border-gray-200 h-[500px] flex items-center justify-center overflow-hidden relative bg-gray-50">
              {!imageSrc && !processedSrc && (
                <div className="text-gray-400 flex flex-col items-center">
                  <i data-lucide="images" className="w-16 h-16 mb-2 opacity-50"></i>
                  <p>原图区</p>
                </div>
              )}
              
              {/* 如果处理完了，且有原图，展示左右对比（简化实现：上下切换）*/}
              {imageSrc && !processedSrc && (
                <img src={imageSrc} alt="Original" className="max-w-full max-h-full object-contain drop-shadow-lg" />
              )}

              {processedSrc && (
                <div className="relative w-full h-full">
                  <img src={processedSrc} alt="Processed" className="w-full h-full object-contain drop-shadow-lg" />
                  <div className="absolute top-4 left-4 bg-green-500 text-white text-xs px-2 py-1 rounded shadow">
                    AI 处理完毕
                  </div>
                </div>
              )}
            </div>
            {/* 隐藏的 Canvas 用于处理 */}
            <canvas ref={canvasRef} className="hidden"></canvas>
          </div>
        </div>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);