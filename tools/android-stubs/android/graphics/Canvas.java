package android.graphics;
public class Canvas {
    public void drawTextOnPath(String t,Path p,float h,float v,Paint paint){}
    public void drawLine(float x1,float y1,float x2,float y2,Paint p){}
    public void drawRect(float l,float t,float r,float b,Paint p){}
    public void drawRect(android.graphics.RectF r,Paint p){}
    public void drawRoundRect(android.graphics.RectF r,float rx,float ry,Paint p){}
    public void drawCircle(float cx,float cy,float r,Paint p){}
    public void drawText(String t,float x,float y,Paint p){}
    public void drawColor(int c){}
    public void drawBitmap(Bitmap b,float l,float t,Paint p){}
    public void save(){}
    public void restore(){}
    public void translate(float dx,float dy){}
    public void rotate(float d){}
    public int saveLayerAlpha(float l,float t,float r,float b,int a){return 0;}
}
