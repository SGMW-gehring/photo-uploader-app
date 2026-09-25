package android.graphics;
public class Bitmap {
    public int getWidth(){return 0;}
    public int getHeight(){return 0;}
    public void recycle(){}
    public void getPixels(int[] px,int off,int stride,int x,int y,int w,int h){}
    public void setPixels(int[] px,int off,int stride,int x,int y,int w,int h){}
    public int getPixel(int x,int y){return 0;}
    public Bitmap copy(Config c,boolean m){return this;}
    public static Bitmap createBitmap(int w,int h,Config c){return new Bitmap();}
    public boolean compress(CompressFormat f,int q,java.io.OutputStream o){return true;}
    public static Bitmap createScaledBitmap(Bitmap b,int w,int h,boolean f){return b;}
    public static Bitmap createBitmap(Bitmap b,int x,int y,int w,int h,Matrix m,boolean f){return b;}
    public enum CompressFormat { JPEG, PNG }
    public enum Config { ARGB_8888, RGB_565 }
}
