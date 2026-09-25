package androidx.camera.core;
public class ImageAnalysis extends UseCase {
    public static final int STRATEGY_KEEP_ONLY_LATEST=0, STRATEGY_BLOCK_PRODUCER=1;
    public static final int OUTPUT_IMAGE_FORMAT_RGBA_8888=1, OUTPUT_IMAGE_FORMAT_YUV_420_888=0;
    public static class Builder {
        public Builder(){}
        public Builder setOutputImageFormat(int f){return this;}
        public Builder setTargetResolution(android.util.Size s){return this;}
        public Builder setBackpressureStrategy(int s){return this;}
        public ImageAnalysis build(){return new ImageAnalysis();}
    }
    public void setAnalyzer(java.util.concurrent.Executor e, Analyzer a){}
    public void clearAnalyzer(){}
    public interface Analyzer { void analyze(ImageProxy image); }
}
