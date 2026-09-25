package androidx.camera.core;
public class ImageCapture extends UseCase {
    public static final int CAPTURE_MODE_MAXIMIZE_QUALITY=0, CAPTURE_MODE_MINIMIZE_LATENCY=1;
    public static class Builder {
        public Builder(){}
        public Builder setCaptureMode(int m){return this;}
        public Builder setTargetResolution(android.util.Size s){return this;}
        public Builder setJpegQuality(int q){return this;}
        public ImageCapture build(){return new ImageCapture();}
    }
    public void takePicture(java.util.concurrent.Executor e, OnImageCapturedCallback cb){}
    public void takePicture(ImageCapture.OutputFileOptions o, java.util.concurrent.Executor e, OnImageSavedCallback cb){}
    public interface OnImageCapturedCallback { void onCaptureSuccess(ImageProxy image); void onError(ImageCaptureException e); }
    public interface OnImageSavedCallback { void onImageSaved(OutputFileResults r); void onError(ImageCaptureException e); }
    public static class OutputFileOptions {}
    public static class OutputFileResults {}
}
