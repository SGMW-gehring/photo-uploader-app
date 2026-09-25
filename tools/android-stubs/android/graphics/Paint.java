package android.graphics;
public class Paint {
    public static final int ANTI_ALIAS_FLAG=1;
    public Paint(int f){}
    public Paint(){}
    public void setTextSize(float s){}
    public float getTextSize(){return 14f;}
    public void setTextAlign(Align a){}
    public void setFakeBoldText(boolean b){}
    public void setShadowLayer(float r,float dx,float dy,int c){}
    public void setColor(int c){}
    public void setAlpha(int a){}
    public void setStrokeWidth(float w){}
    public void setStyle(Style s){}
    public void setAntiAlias(boolean b){}
    public void setTypeface(Object t){}
    public void setStrokeCap(Cap c){}
    public float measureText(String s){return s.length()*10f;}
    public void getTextBounds(String s,int a,int b,android.graphics.Rect r){}
    public android.graphics.Paint.FontMetrics getFontMetrics(){return new FontMetrics();}
    public static class FontMetrics { public float top,ascent,descent,bottom,leading; }
    public enum Align { CENTER, LEFT, RIGHT }
    public enum Style { FILL, STROKE, FILL_AND_STROKE }
    public enum Cap { BUTT, ROUND, SQUARE }
}
