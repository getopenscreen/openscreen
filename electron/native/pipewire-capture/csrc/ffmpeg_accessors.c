#include <libavformat/avformat.h>

/* FFmpeg 8 exposes AVFormatContext as opaque to bindgen on some clang builds.
 * Keep these field reads in C, compiled against the exact headers being linked. */
AVIOContext **osc_avformat_pb(AVFormatContext *context)
{
    return context != NULL ? &context->pb : NULL;
}

AVStream *osc_avformat_stream(AVFormatContext *context, unsigned int index)
{
    if (context == NULL || index >= context->nb_streams) {
        return NULL;
    }
    return context->streams[index];
}

unsigned int osc_avformat_nb_streams(AVFormatContext *context)
{
    return context != NULL ? context->nb_streams : 0;
}
