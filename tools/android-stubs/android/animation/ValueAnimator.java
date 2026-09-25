package android.animation;
public class ValueAnimator {
    public static final int INFINITE=-1, RESTART=1, REVERSE=2;
    public static ValueAnimator ofFloat(float... v){return new ValueAnimator();}
    public static ValueAnimator ofInt(int... v){return new ValueAnimator();}
    public void setDuration(long d){}
    public void setRepeatMode(int m){}
    public void setRepeatCount(int c){}
    public void start(){}
    public void cancel(){}
    public void end(){}
    public void addUpdateListener(AnimatorUpdateListener l){}
    public void addListener(AnimatorListener l){}
    public Object getAnimatedValue(){return Float.valueOf(0f);}
    public void setFloatValues(float... v){}
    public interface AnimatorUpdateListener { void onAnimationUpdate(ValueAnimator a); }
    public interface AnimatorListener { void onAnimationStart(ValueAnimator a); void onAnimationEnd(ValueAnimator a); void onAnimationCancel(ValueAnimator a); void onAnimationRepeat(ValueAnimator a); }
}
