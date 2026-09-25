package androidx.camera.core;
public class ImageProxy implements java.io.Closeable {
    public void close(){}
    public int getWidth(){return 0;}
    public int getHeight(){return 0;}
    public int getFormat(){return 0;}
    public android.graphics.Bitmap toBitmap(){return new android.graphics.Bitmap();}
    public PlaneProxy[] getPlanes(){return new PlaneProxy[0];}
    public ImageInfo getImageInfo(){return new ImageInfo();}
    public android.graphics.Rect getCropRect(){return new android.graphics.Rect();}
    public long getTimestamp(){return 0L;}
    public interface PlaneProxy { java.nio.ByteBuffer getBuffer(); int getPixelStride(); int getRowStride(); }
    public static class ImageInfo { public int getRotationDegrees(){return 0;} public int getTargetRotation(){return 0;} }
}
