package android.widget;
import android.content.Context;
import android.view.View;
import android.view.ViewGroup;
public class LinearLayout extends ViewGroup {
    public LinearLayout(Context c){super(c);}
    public void setOrientation(int o){}
    public void setGravity(int g){}
    public void addView(View v){}
    public void addView(View v,ViewGroup.LayoutParams p){}
    public static final int HORIZONTAL=0, VERTICAL=1;
    public static class LayoutParams extends ViewGroup.LayoutParams {
        public float weight;
        public int bottomMargin, topMargin, leftMargin, rightMargin;
        public int gravity;
        public LayoutParams(int w,int h){super(w,h);}
        public LayoutParams(int w,int h,float wt){super(w,h);weight=wt;}
    }
}
