package androidx.camera.core;
public class Preview extends UseCase {
    public static class Builder {
        public Builder(){}
        public Builder setTargetResolution(android.util.Size s){return this;}
        public Builder setTargetAspectRatio(int r){return this;}
        public Preview build(){return new Preview();}
    }
    public void setSurfaceProvider(Object p){}
}
